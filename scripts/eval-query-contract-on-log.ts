import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import type { QueryContractSource } from "../lib/query-contract";

type QueryLogRow = {
  id?: number;
  ts: number;
  tab?: string | null;
  question: string;
  sql?: string | null;
  rows?: number | null;
  error?: string | null;
  guardrails?: string | null;
};

type EvaluatedRow = {
  row: QueryLogRow;
  source: QueryContractSource;
  fired: string[];
  warnings: string[];
  enforced: string[];
  blockReasons: string[];
  retryIssues: string[];
  rewritten: boolean;
};

const SOURCE_TABS = new Set(["current", "historical", "nibrs", "shr", "hate_crime"]);

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function positiveNumberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(name: string): number | null {
  const raw = argValue(name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dbPath(): string {
  return argValue("--db") || path.join(process.cwd(), "query_log.db");
}

function outPath(): string {
  const explicit = argValue("--out");
  if (explicit) return explicit;
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), "docs", `query-contract-log-sweep-${stamp}.md`);
}

function normalizeSource(tab: string | null | undefined): QueryContractSource | null {
  if (!tab) return null;
  const normalized = tab.trim().toLowerCase();
  if (normalized === "hc" || normalized === "hate-crime" || normalized === "hate crime") return "hate_crime";
  return SOURCE_TABS.has(normalized) ? normalized as QueryContractSource : null;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => (row as { name?: string }).name === column);
}

function looksLikeSelect(sql: string | null | undefined): sql is string {
  return !!sql && /^\s*(?:WITH|SELECT)\b/i.test(sql);
}

function timestampToDate(ts: number): Date {
  return new Date(ts < 10_000_000_000 ? ts * 1000 : ts);
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function truncate(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function main() {
  const inputDb = dbPath();
  const days = positiveNumberArg("--days", 90);
  const limit = optionalPositiveInt("--limit");
  const sinceId = optionalPositiveInt("--since-id");
  const errorsOnly = hasFlag("--errors-only");
  const showAll = hasFlag("--all");
  const failOnEnforced = hasFlag("--fail-on-enforced");
  const target = outPath();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const db = new Database(inputDb, { readonly: true, fileMustExist: true });
  try {
    const hasId = columnExists(db, "query_log", "id");
    const columns = db.prepare("PRAGMA table_info(query_log)").all().map((row) => (row as { name: string }).name);
    const select = [
      hasId ? "id" : "rowid AS id",
      "ts",
      columns.includes("tab") ? "tab" : "NULL AS tab",
      "question",
      columns.includes("sql") ? "sql" : "NULL AS sql",
      columns.includes("rows") ? "rows" : "NULL AS rows",
      columns.includes("error") ? "error" : "NULL AS error",
      columns.includes("guardrails") ? "guardrails" : "NULL AS guardrails",
    ].join(", ");

    const conditions = ["ts >= ?", "question IS NOT NULL", "question <> ''"];
    const params: unknown[] = [cutoff];
    if (sinceId !== null) {
      conditions.push(`${hasId ? "id" : "rowid"} >= ?`);
      params.push(sinceId);
    }
    if (errorsOnly) conditions.push("error IS NOT NULL", "length(error) > 0");
    const limitClause = limit ? `LIMIT ${limit}` : "";

    const rows = db.prepare(`
      SELECT ${select}
      FROM query_log
      WHERE ${conditions.join(" AND ")}
      ORDER BY ts ASC
      ${limitClause}
    `).all(...params) as QueryLogRow[];

    const skipped = {
      noSource: 0,
      noSql: 0,
    };
    const evaluated: EvaluatedRow[] = [];

    for (const row of rows) {
      const source = normalizeSource(row.tab);
      if (!source) {
        skipped.noSource += 1;
        continue;
      }
      if (!looksLikeSelect(row.sql)) {
        skipped.noSql += 1;
        continue;
      }
      const result = validateQueryContractSql({
        question: row.question,
        source,
        sql: row.sql,
      });
      evaluated.push({
        row,
        source,
        fired: result.fired,
        warnings: result.warnings,
        enforced: result.enforced,
        blockReasons: result.blockReasons,
        retryIssues: result.retryIssues,
        rewritten: result.sql !== row.sql,
      });
    }

    const interesting = evaluated.filter((item) =>
      showAll || item.fired.length > 0 || item.warnings.length > 0 || item.enforced.length > 0
    );
    const enforcedRows = evaluated.filter((item) => item.enforced.length > 0);
    const warningRows = evaluated.filter((item) => item.warnings.length > 0);
    const rewriteRows = evaluated.filter((item) => item.rewritten || item.fired.length > 0);

    writeReport({
      target,
      inputDb,
      days,
      cutoff,
      limit,
      sinceId,
      errorsOnly,
      showAll,
      rows,
      skipped,
      evaluated,
      interesting,
      enforcedRows,
      warningRows,
      rewriteRows,
    });

    console.log(`query contract log sweep: rows=${rows.length} evaluated=${evaluated.length} interesting=${interesting.length} enforced=${enforcedRows.length} warnings=${warningRows.length} rewrites=${rewriteRows.length}`);
    console.log(`Wrote ${target}`);

    if (failOnEnforced && enforcedRows.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function writeReport(opts: {
  target: string;
  inputDb: string;
  days: number;
  cutoff: number;
  limit: number | null;
  sinceId: number | null;
  errorsOnly: boolean;
  showAll: boolean;
  rows: QueryLogRow[];
  skipped: { noSource: number; noSql: number };
  evaluated: EvaluatedRow[];
  interesting: EvaluatedRow[];
  enforcedRows: EvaluatedRow[];
  warningRows: EvaluatedRow[];
  rewriteRows: EvaluatedRow[];
}) {
  const ruleCounts = countBy(opts.evaluated.flatMap((item) => item.enforced));
  const warningCounts = countBy(opts.evaluated.flatMap((item) => item.warnings));
  const firedCounts = countBy(opts.evaluated.flatMap((item) => item.fired));
  const sourceCounts = countBy(opts.evaluated.map((item) => item.source));

  const lines: string[] = [];
  lines.push(`# Query Contract Log Sweep - ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push("Generated by `npx tsx scripts/eval-query-contract-on-log.ts`.");
  lines.push("");
  lines.push("- Shadow-only: no app behavior is changed and no model/API calls are made.");
  lines.push(`- Query log: \`${opts.inputDb}\``);
  lines.push(`- Window: last ${opts.days} day(s), since ${new Date(opts.cutoff).toISOString()}`);
  if (opts.limit) lines.push(`- Limit: ${opts.limit}`);
  if (opts.sinceId) lines.push(`- Since log id: ${opts.sinceId}`);
  if (opts.errorsOnly) lines.push("- Filter: rows with non-empty `error` only");
  if (opts.showAll) lines.push("- Output mode: all evaluated rows");
  lines.push(`- Rows read: ${opts.rows.length}`);
  lines.push(`- Rows evaluated: ${opts.evaluated.length}`);
  lines.push(`- Skipped without source: ${opts.skipped.noSource}`);
  lines.push(`- Skipped without SELECT/CTE SQL: ${opts.skipped.noSql}`);
  lines.push(`- Rows with enforced retry/block contract issues: ${opts.enforcedRows.length}`);
  lines.push(`- Rows with warnings: ${opts.warningRows.length}`);
  lines.push(`- Rows with contract rewrites: ${opts.rewriteRows.length}`);
  lines.push("");

  lines.push("## Source Counts");
  lines.push("");
  lines.push("| Source | Rows | ");
  lines.push("| --- | ---: |");
  for (const [source, count] of [...sourceCounts.entries()].sort()) {
    lines.push(`| ${source} | ${count} |`);
  }
  lines.push("");

  if (ruleCounts.size > 0) {
    lines.push("## Enforced Contract Counts");
    lines.push("");
    lines.push("| Rule | Rows | ");
    lines.push("| --- | ---: |");
    for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`| ${rule} | ${count} |`);
    }
    lines.push("");
  }

  if (warningCounts.size > 0) {
    lines.push("## Warning Counts");
    lines.push("");
    lines.push("| Warning | Rows | ");
    lines.push("| --- | ---: |");
    for (const [rule, count] of [...warningCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40)) {
      lines.push(`| ${rule} | ${count} |`);
    }
    lines.push("");
  }

  if (firedCounts.size > 0) {
    lines.push("## Rewrite Counts");
    lines.push("");
    lines.push("| Rewrite | Rows | ");
    lines.push("| --- | ---: |");
    for (const [rule, count] of [...firedCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`| ${rule} | ${count} |`);
    }
    lines.push("");
  }

  lines.push("## Rows To Review");
  lines.push("");
  lines.push("| Log | Time | Source | Rows | Error | Question | Fired | Warnings | Enforced | Action | SQL | ");
  lines.push("| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
  for (const item of opts.interesting) {
    const action = item.blockReasons.length > 0
      ? "block"
      : item.retryIssues.length > 0
        ? "retry"
        : item.rewritten
          ? "rewrite"
          : "warn";
    lines.push([
      item.row.id ?? "",
      timestampToDate(item.row.ts).toISOString(),
      item.source,
      item.row.rows ?? "",
      escapeCell(truncate(item.row.error || "")),
      escapeCell(truncate(item.row.question, 180)),
      escapeCell(item.fired.join(", ")),
      escapeCell(item.warnings.join(", ")),
      escapeCell(item.enforced.join(", ")),
      action,
      escapeCell(truncate(item.row.sql || "", 260)),
    ].map((value) => String(value)).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  if (opts.interesting.length === 0) lines.push("| none |  |  |  |  |  |  |  |  |  |  |");
  lines.push("");

  lines.push("## Review Notes");
  lines.push("");
  lines.push("- `enforced` means the current contract layer would retry or block this SQL before execution.");
  lines.push("- `fired` means the current contract layer can auto-rewrite the logged SQL, usually for source-specific state codes or city suffixes.");
  lines.push("- Older rows may represent issues already fixed; use this report to find recurring classes, then promote stable examples into `test-layer3-contract-corpus.ts`.");
  lines.push("");

  fs.mkdirSync(path.dirname(opts.target), { recursive: true });
  fs.writeFileSync(opts.target, `${lines.join("\n")}\n`, "utf8");
}

main();
