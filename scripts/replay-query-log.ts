#!/usr/bin/env npx tsx
/**
 * Replay a production query-log CSV against the deployed API and produce a
 * deterministic GO/NO-GO scorecard.
 *
 * Usage:
 *   npx tsx scripts/replay-query-log.ts
 *   npx tsx scripts/replay-query-log.ts --file C:\Users\jeffm\Downloads\nibrs-query-log-2026-06-08.csv
 *   npx tsx scripts/replay-query-log.ts --host https://nibrsai.com --limit 25
 *   npx tsx scripts/replay-query-log.ts --ids 3835,3838,3842
 *   npx tsx scripts/replay-query-log.ts --tabs nibrs,shr --delay 2500
 *
 * The script uses deterministic checks only. It does not ask another model to
 * grade answers. Rows marked needs_review are the right candidates for manual
 * or model-assisted review after the reproducible checks have run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type TabId = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
type Score =
  | "correct_candidate"
  | "acceptable_limitation"
  | "false_refusal_candidate"
  | "guardrail_failure"
  | "silent_wrong_risk"
  | "chart_issue"
  | "empty_result"
  | "infrastructure"
  | "needs_review";

type LogRow = {
  id: number;
  ts: string;
  tab: TabId;
  question: string;
  sql: string;
  rows: number;
  error: string;
  ms: number;
};

type ApiResponse = {
  sql: string | null;
  explanation: string;
  title: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  chartConfig: unknown | null;
  httpStatus: number;
  raw: Record<string, unknown>;
};

type ReplayResult = {
  id: number;
  ts: string;
  tab: TabId;
  question: string;
  original: {
    rows: number;
    error: string;
    hadSql: boolean;
  };
  replay: {
    httpStatus: number;
    rowCount: number;
    sql: string | null;
    title: string;
    explanation: string;
    hasChart: boolean;
  };
  score: Score;
  issues: string[];
  durationMs: number;
};

type Options = {
  file: string;
  host: string;
  limit: number | null;
  delayMs: number;
  ids: Set<number> | null;
  tabs: Set<TabId> | null;
  outputDir: string;
  dryRun: boolean;
  noHistory: boolean;
};

const DEFAULT_FILE = "C:\\Users\\jeffm\\Downloads\\nibrs-query-log-2026-06-08.csv";
const DEFAULT_HOST = "https://nibrsai.com";
const SESSION_ID = `query-log-replay-${Date.now().toString(36)}`;
const TIMEOUT_MS = 120_000;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    file: DEFAULT_FILE,
    host: process.env.REPLAY_HOST || DEFAULT_HOST,
    limit: null,
    delayMs: Number(process.env.REPLAY_DELAY_MS || 2500),
    ids: null,
    tabs: null,
    outputDir: "audit",
    dryRun: false,
    noHistory: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--file") opts.file = next();
    else if (arg === "--host") opts.host = next().replace(/\/$/, "");
    else if (arg === "--limit") opts.limit = Number(next());
    else if (arg === "--delay") opts.delayMs = Number(next());
    else if (arg === "--ids") opts.ids = parseIdSet(next());
    else if (arg === "--tabs") opts.tabs = new Set(next().split(",").map(s => s.trim()).filter(Boolean) as TabId[]);
    else if (arg === "--out") opts.outputDir = next();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-history") opts.noHistory = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: npx tsx scripts/replay-query-log.ts [options]

Options:
  --file PATH       CSV log path. Default: ${DEFAULT_FILE}
  --host URL        API host. Default: ${DEFAULT_HOST}
  --limit N         Replay at most N filtered rows
  --ids LIST        IDs or ranges, e.g. 3835,3838-3842
  --tabs LIST       Tabs to replay, e.g. nibrs,shr
  --delay MS        Delay between requests. Default: 2500
  --out DIR         Output directory. Default: audit
  --dry-run         Parse/filter only; do not call the API
  --no-history      Do not send approximate per-tab conversation history
`);
}

function parseIdSet(value: string): Set<number> {
  const ids = new Set<number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let id = Math.min(start, end); id <= Math.max(start, end); id++) ids.add(id);
    } else {
      ids.add(Number(trimmed));
    }
  }
  return ids;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim().length > 0));
}

function loadLogRows(path: string): LogRow[] {
  const csv = parseCsv(readFileSync(path, "utf8"));
  const [header, ...records] = csv;
  const index = new Map(header.map((name, i) => [name, i]));
  const required = ["id", "ts", "tab", "question", "sql", "rows", "error", "ms"];
  for (const name of required) {
    if (!index.has(name)) throw new Error(`CSV missing required column: ${name}`);
  }

  return records.map(record => ({
    id: Number(record[index.get("id")!]),
    ts: record[index.get("ts")!] || "",
    tab: normalizeTab(record[index.get("tab")!]),
    question: record[index.get("question")!] || "",
    sql: record[index.get("sql")!] || "",
    rows: Number(record[index.get("rows")!] || 0),
    error: record[index.get("error")!] || "",
    ms: Number(record[index.get("ms")!] || 0),
  })).filter(row => row.id && row.question.trim());
}

function normalizeTab(tab: string): TabId {
  if (tab === "hate_crime" || tab === "hc") return "hate_crime";
  if (tab === "current" || tab === "historical" || tab === "nibrs" || tab === "shr") return tab;
  throw new Error(`Unsupported tab in log: ${tab}`);
}

function apiRoute(tab: TabId): string {
  if (tab === "current" || tab === "historical") return "/api/query";
  if (tab === "nibrs") return "/api/nibrs-query";
  if (tab === "shr") return "/api/shr-query";
  return "/api/hc-query";
}

function buildBody(question: string, tab: TabId, pageToken: string, sessionId: string, history: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = { question, pageToken, sessionId };
  if (history.length > 0) body.history = history.slice(-6);
  if (tab === "current") body.mode = "current";
  if (tab === "historical") body.mode = "historical";
  return body;
}

async function fetchPageToken(host: string): Promise<string> {
  const res = await fetch(`${host}/api/page-token`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Failed to fetch page token: HTTP ${res.status}`);
  const data = await res.json() as { token: string };
  return data.token;
}

async function runQuery(host: string, row: LogRow, pageToken: string, sessionId: string, history: unknown[]): Promise<ApiResponse> {
  const route = apiRoute(row.tab);
  const body = buildBody(row.question, row.tab, pageToken, sessionId, history);
  const url = `${host}${route}`;
  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 429) {
    const parsedRetryAfter = Number(res.headers.get("retry-after") || 30);
    const retryAfter = Number.isFinite(parsedRetryAfter) ? Math.max(5, parsedRetryAfter) : 30;
    console.log(`rate limited; waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    const freshToken = await fetchPageToken(host);
    await sleep(2500);
    res = await postRetry(url, body, { pageToken: freshToken });
  } else if (res.status === 202) {
    console.log("captcha gate; waiting 20s with fresh token");
    await sleep(20_000);
    const freshToken = await fetchPageToken(host);
    await sleep(2500);
    res = await postRetry(url, body, { pageToken: freshToken, sessionId: `${sessionId}-retry` });
  } else if (res.status === 403) {
    console.log("token rejected; refreshing token");
    const freshToken = await fetchPageToken(host);
    await sleep(2500);
    res = await postRetry(url, body, { pageToken: freshToken });
  }

  return parseResponse(row.tab, res);
}

async function postRetry(url: string, body: Record<string, unknown>, override: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...override }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function parseResponse(tab: TabId, res: Response): Promise<ApiResponse> {
  if (tab === "current" || tab === "historical") return parseSseResponse(res);
  return parseJsonResponse(res);
}

async function parseSseResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  if (!res.ok) {
    const err = tryParseJson(text);
    return emptyResponse(res.status, String(err?.error || `HTTP ${res.status}`), err || {});
  }

  let result: Record<string, unknown> = {};
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find(part => part.startsWith("data: "));
    if (!line) continue;
    const data = tryParseJson(line.slice(6));
    if (data?.type === "result") result = data;
    if (data?.type === "error" && !result.sql) result = data;
  }
  return normalizeApiResponse(result, res.status);
}

async function parseJsonResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  const data = tryParseJson(text);
  if (!data) return emptyResponse(res.status, `JSON parse error: ${text.slice(0, 160)}`, {});
  if (!res.ok || data.success === false || data.error) {
    return emptyResponse(res.status, String(data.error || `HTTP ${res.status}`), data);
  }
  return normalizeApiResponse(data, res.status);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeApiResponse(data: Record<string, unknown>, httpStatus: number): ApiResponse {
  const rows = Array.isArray(data.rows) ? data.rows as Record<string, unknown>[] : [];
  const columns = Array.isArray(data.columns) ? data.columns as string[] : (rows[0] ? Object.keys(rows[0]) : []);
  return {
    sql: typeof data.sql === "string" && data.sql.trim() ? data.sql : null,
    explanation: String(data.explanation || data.text || ""),
    title: String(data.title || ""),
    rows,
    rowCount: Number(data.rowCount ?? rows.length ?? 0),
    columns,
    chartConfig: data.chartConfig ?? null,
    httpStatus,
    raw: data,
  };
}

function emptyResponse(httpStatus: number, explanation: string, raw: Record<string, unknown>): ApiResponse {
  return {
    sql: null,
    explanation,
    title: "",
    rows: [],
    rowCount: 0,
    columns: [],
    chartConfig: null,
    httpStatus,
    raw,
  };
}

function scoreResult(row: LogRow, resp: ApiResponse): { score: Score; issues: string[] } {
  const issues: string[] = [];
  const sql = resp.sql || "";
  const explanation = resp.explanation || "";
  const sqlLower = sql.toLowerCase();
  const explanationLower = explanation.toLowerCase();

  if (resp.httpStatus !== 200) {
    if (resp.httpStatus >= 400 && resp.httpStatus < 600 && /too complex|generated an invalid query|no such column|syntax error|ambiguous column|database/i.test(explanation)) {
      issues.push(`HTTP ${resp.httpStatus}: ${explanation.slice(0, 120)}`);
      return { score: "guardrail_failure", issues };
    }
    issues.push(`HTTP ${resp.httpStatus}: ${explanation.slice(0, 120)}`);
    return { score: "infrastructure", issues };
  }
  if (/captcha|required|too many requests|rate limit|server error/i.test(explanation) && !resp.sql) {
    issues.push(explanation.slice(0, 160));
    return { score: "infrastructure", issues };
  }

  const riskIssues = detectSilentWrongRisks(sql, row);
  if (riskIssues.length > 0) {
    issues.push(...riskIssues);
    return { score: "silent_wrong_risk", issues };
  }

  if (/guardrail_override|sql_guardrail_second_failure|raw_table_second_failure|DB retry failed|I can't reliably combine data from two different summary tables/i.test(explanation)) {
    issues.push("Guardrail/SQL failure surfaced in explanation");
    return { score: "guardrail_failure", issues };
  }

  if (!resp.sql) {
    if (isAcceptableLimitation(row.question, explanation)) {
      issues.push("Text-only limitation/refusal appears acceptable");
      return { score: "acceptable_limitation", issues };
    }
    issues.push("No SQL returned for a question that may be answerable");
    return { score: "false_refusal_candidate", issues };
  }

  if (resp.rowCount === 0) {
    if (/not in our dataset|no data was found|returned no results|may not report|not available|incomplete coverage/i.test(explanation)) {
      issues.push("SQL ran but returned no rows with a data-availability explanation");
      return { score: "empty_result", issues };
    }
    issues.push("SQL ran but returned zero rows");
    return { score: "empty_result", issues };
  }

  if (looksChartable(resp) && !resp.chartConfig) {
    issues.push("Obvious year-series data returned without chartConfig");
    return { score: "chart_issue", issues };
  }

  if (/no such column|syntax error|ambiguous column|near ".+": syntax/i.test(explanationLower)) {
    issues.push("Explanation suggests SQL/runtime failure");
    return { score: "guardrail_failure", issues };
  }

  if (!sqlLower.includes("select")) {
    issues.push("Response had rows but SQL is missing or non-SELECT");
    return { score: "needs_review", issues };
  }

  return { score: "correct_candidate", issues };
}

function detectSilentWrongRisks(sql: string, row: LogRow): string[] {
  if (!sql) return [];
  const issues: string[] = [];

  const likeNoState = /(?:city|agency)\s+LIKE\s+'[^']*%[^']*'/i.test(sql) &&
    !/\bstate\s*=\s*'[A-Za-z]{2}'/i.test(sql);
  if (likeNoState) issues.push("Wildcard city/agency LIKE without state filter");

  if (/GROUP\s+BY\s+(?:\w+\.)?age_group\s+GROUP\s+BY/i.test(sql)) {
    issues.push("Duplicate outer GROUP BY age_group/year pattern");
  }

  const directCityStateJoin =
    /\bFROM\s+(?:summary_victim_city_monthly|summary_city_monthly)\b[\s\S]*?\bJOIN\s+(?:summary_victim_state_monthly|summary_state_monthly)\b/i.test(sql) ||
    /\bFROM\s+(?:summary_victim_state_monthly|summary_state_monthly)\b[\s\S]*?\bJOIN\s+(?:summary_victim_city_monthly|summary_city_monthly)\b/i.test(sql);
  if (directCityStateJoin) issues.push("Direct city-level to state-level summary join");

  const summaryTables = [...new Set((sql.match(/\bsummary_\w+/gi) || []).map(t => t.toLowerCase()))];
  if (/\bJOIN\b/i.test(sql) && summaryTables.length >= 2 && !isAllowedSummaryJoin(summaryTables)) {
    issues.push(`Cross-summary join: ${summaryTables.join(", ")}`);
  }

  if (row.tab === "nibrs") {
    const rawTables = (sql.match(/\b(?:FROM|JOIN)\s+(incidents|offenses|victims|offenders|arrestees|property)\b/gi) || []);
    if (rawTables.length > 0 && !hasTightNibrsRawFilters(sql)) {
      issues.push("NIBRS raw table query lacks tight state/year filters");
    }
  }

  if (/\bagencies\b/i.test(sql) && /\bcity\s*=\s*'[A-Z]/i.test(sql) && !/agency_type\s*=\s*'City'/i.test(sql) && !/pop_group\s+LIKE\s+'1%'/i.test(sql) && !/ORDER\s+BY\s+pop(?:ulation|_group)[\s\S]*LIMIT\s+1/i.test(sql) && !/\b(county|sheriff|parish)\b/i.test(row.question)) {
    issues.push("NIBRS city agency lookup may include county/sub-agencies");
  }

  return issues;
}

function isAllowedSummaryJoin(tables: string[]): boolean {
  const set = new Set(tables);
  if ([...set].every(t => /monthly$/.test(t))) return true;
  if (set.has("summary_victim_circumstance_clearance_demo")) return true;
  if (set.has("summary_victim_weapon_circumstance_demo")) return true;
  return false;
}

function hasTightNibrsRawFilters(sql: string): boolean {
  return /\bstate\s*=\s*'[A-Z]{2}'/i.test(sql) &&
    (/\byear\s*=\s*\d{4}/i.test(sql) || /\byear\s+BETWEEN\s+\d{4}\s+AND\s+\d{4}/i.test(sql) || /\byear\s+IN\s*\(/i.test(sql));
}

function isAcceptableLimitation(question: string, explanation: string): boolean {
  const combined = `${question}\n${explanation}`.toLowerCase();
  const unsupportedQuestion = /\b(zip|zipcode|census tract|block group|msa|metro area|conviction|sentenc|prison|dna evidence|case outcome|nonfatal shooting|people shot)\b/.test(combined);
  const limitationText = /\b(not available|not in our dataset|does not track|cannot|can't|not able|try the|clarify|which .+ did you mean)\b/.test(combined);
  return unsupportedQuestion || limitationText;
}

function looksChartable(resp: ApiResponse): boolean {
  if (resp.rows.length <= 1) return false;
  const columns = resp.columns.length > 0 ? resp.columns : Object.keys(resp.rows[0] || {});
  if (!columns.includes("year")) return false;
  const numeric = columns.filter(col => col !== "year" && col !== "month" && resp.rows.some(row => typeof row[col] === "number"));
  const nonTimeNonNumeric = columns.filter(col => col !== "year" && col !== "month" && !numeric.includes(col));
  return numeric.length > 0 && nonTimeNonNumeric.length === 0;
}

function resultHistoryEntry(result: ReplayResult): { user: unknown; assistant: unknown } {
  return {
    user: { role: "user", content: result.question },
    assistant: {
      role: "assistant",
      content: JSON.stringify({
        sql: result.replay.sql,
        explanation: result.replay.explanation,
        title: result.replay.title,
      }),
    },
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function summarize(results: ReplayResult[]) {
  const counts = new Map<Score, number>();
  for (const result of results) counts.set(result.score, (counts.get(result.score) || 0) + 1);
  const silentWrong = counts.get("silent_wrong_risk") || 0;
  const guardrail = counts.get("guardrail_failure") || 0;
  const falseRefusal = counts.get("false_refusal_candidate") || 0;
  const infra = counts.get("infrastructure") || 0;
  let recommendation = "HARD GO";
  if (silentWrong > 0 || guardrail > 0) recommendation = "NO-GO";
  else if (falseRefusal > 0 || infra > 0 || (counts.get("needs_review") || 0) > 0) recommendation = "SOFT GO";
  return { counts: Object.fromEntries(counts), recommendation };
}

function writeReports(opts: Options, rows: LogRow[], results: ReplayResult[]) {
  mkdirSync(opts.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(opts.outputDir, `query-log-replay-${stamp}`);
  const summary = summarize(results);
  writeFileSync(`${base}.json`, JSON.stringify({ options: serializeOptions(opts), source: basename(opts.file), summary, results }, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(opts, rows, results, summary));
  return { json: `${base}.json`, markdown: `${base}.md` };
}

function serializeOptions(opts: Options) {
  return {
    ...opts,
    ids: opts.ids ? [...opts.ids].sort((a, b) => a - b) : null,
    tabs: opts.tabs ? [...opts.tabs].sort() : null,
  };
}

function renderMarkdown(opts: Options, rows: LogRow[], results: ReplayResult[], summary: ReturnType<typeof summarize>): string {
  const lines: string[] = [];
  lines.push("# Query Log Replay Scorecard", "");
  lines.push(`- Source: \`${opts.file}\``);
  lines.push(`- Host: \`${opts.host}\``);
  lines.push(`- Rows selected: ${rows.length}`);
  lines.push(`- Rows replayed: ${results.length}`);
  lines.push(`- Recommendation: **${summary.recommendation}**`, "");
  lines.push("## Counts", "");
  for (const [score, count] of Object.entries(summary.counts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${score}: ${count}`);
  }
  lines.push("", "## High-Risk Rows", "");
  const highRisk = results.filter(r => ["silent_wrong_risk", "guardrail_failure", "false_refusal_candidate", "chart_issue", "needs_review", "infrastructure"].includes(r.score));
  if (highRisk.length === 0) {
    lines.push("No high-risk rows found.");
  } else {
    for (const r of highRisk) {
      lines.push(`### ${r.id} [${r.tab}] ${r.score}`);
      lines.push(`Question: ${r.question}`);
      lines.push(`Issues: ${r.issues.join("; ") || "none"}`);
      lines.push(`Replay rows: ${r.replay.rowCount}; original rows: ${r.original.rows}; original error: ${r.original.error || "none"}`);
      if (r.replay.sql) lines.push(`SQL: \`${r.replay.sql.replace(/\s+/g, " ").slice(0, 500)}${r.replay.sql.length > 500 ? "..." : ""}\``);
      lines.push("");
    }
  }
  lines.push("## All Results", "");
  lines.push("| ID | Tab | Score | Replay Rows | Original Rows | Issues |");
  lines.push("|---:|---|---|---:|---:|---|");
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.tab} | ${r.score} | ${r.replay.rowCount} | ${r.original.rows} | ${r.issues.join("; ").replace(/\|/g, "/")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let rows = loadLogRows(opts.file)
    .filter(row => !opts.ids || opts.ids.has(row.id))
    .filter(row => !opts.tabs || opts.tabs.has(row.tab))
    .sort((a, b) => a.id - b.id);
  if (opts.limit !== null) rows = rows.slice(0, opts.limit);

  console.log(`Loaded ${rows.length} row(s) from ${opts.file}`);
  console.log(`Host: ${opts.host}`);
  console.log(`Session: ${SESSION_ID}`);
  console.log(`Delay: ${opts.delayMs}ms`);

  if (opts.dryRun) {
    for (const row of rows) console.log(`#${row.id} [${row.tab}] ${row.question}`);
    return;
  }

  let pageToken = await fetchPageToken(opts.host);
  const histories = new Map<TabId, unknown[]>();
  const results: ReplayResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const history = opts.noHistory ? [] : (histories.get(row.tab) || []);
    const started = Date.now();
    process.stdout.write(`[${i + 1}/${rows.length}] #${row.id} [${row.tab}] `);

    let resp: ApiResponse;
    try {
      resp = await runQuery(opts.host, row, pageToken, `${SESSION_ID}-${row.tab}`, history);
    } catch (error) {
      resp = emptyResponse(0, error instanceof Error ? error.message : String(error), {});
    }

    const scored = scoreResult(row, resp);
    const result: ReplayResult = {
      id: row.id,
      ts: row.ts,
      tab: row.tab,
      question: row.question,
      original: {
        rows: row.rows,
        error: row.error,
        hadSql: Boolean(row.sql.trim()),
      },
      replay: {
        httpStatus: resp.httpStatus,
        rowCount: resp.rowCount,
        sql: resp.sql,
        title: resp.title,
        explanation: resp.explanation,
        hasChart: Boolean(resp.chartConfig),
      },
      score: scored.score,
      issues: scored.issues,
      durationMs: Date.now() - started,
    };
    results.push(result);
    console.log(`${result.score} rows=${result.replay.rowCount} ${result.issues[0] ? `(${result.issues[0]})` : ""}`);

    if (!opts.noHistory) {
      const entries = resultHistoryEntry(result);
      histories.set(row.tab, [...history, entries.user, entries.assistant].slice(-8));
    }

    if (i < rows.length - 1) await sleep(opts.delayMs);
  }

  const paths = writeReports(opts, rows, results);
  const summary = summarize(results);
  console.log("\nSummary:", summary.counts);
  console.log(`Recommendation: ${summary.recommendation}`);
  console.log(`Wrote ${paths.json}`);
  console.log(`Wrote ${paths.markdown}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
