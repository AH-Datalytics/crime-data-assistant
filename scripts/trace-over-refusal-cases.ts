/**
 * Option 3 trace (audit/presentation-2026-10-20/OVER-REFUSAL-PLAN-r3.md, "the trace first"): replays each inventory
 * case's exact baseline request body through the real route handler offline (fixture databases from
 * scripts/fixtures/operation-taxonomy, model stubbed, network refused) and records where it stops: the final reply,
 * the log row's owner/guardrail tags, whether a statement ran, and whether the model was consulted.
 *   npx tsx scripts/trace-over-refusal-cases.ts <bodies.json> <out.json>
 * Diagnostic only: fixture data cannot certify source availability; stages after recognition depend on the fixture.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

const [IN, OUT] = process.argv.slice(2);
let modelCalls = 0;
const network: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (!url.includes("api.anthropic.com")) { network.push(url); throw new Error(`network refused: ${url}`); }
  modelCalls += 1;
  return new Response(JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: JSON.stringify({ sql: "SELECT 'MODEL-SQL-PROBE' AS probe", explanation: "STUB-MODEL-TEXT", title: "", chartHint: "none", xAxis: "", yAxis: "" }) }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof globalThis.fetch;

const DDL = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "option3-trace-"));
for (const [name, ddl] of [["crime_data.db", "crime_data.ddl.sql"], ["query_log.db", "query_log.ddl.sql"], ["nibrs.db", "nibrs.ddl.sql"], ["nibrs_rollups.db", "rollup.ddl.sql"], ["shr.db", "shr.ddl.sql"], ["hate_crime.db", "hc.ddl.sql"]]) {
  const db = new Database(path.join(DIR, name)); db.pragma("journal_mode = WAL"); db.exec(fs.readFileSync(path.join(DDL, ddl), "utf8")); db.close();
}
process.env.RTCI_DB_PATH = path.join(DIR, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(DIR, "query_log.db");
process.env.NIBRS_DB_PATH = path.join(DIR, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(DIR, "nibrs_rollups.db");
process.env.SHR_DB_PATH = path.join(DIR, "shr.db");
process.env.HATE_CRIME_DB_PATH = path.join(DIR, "hate_crime.db");
process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
delete process.env.PROOF_MODE;

const token = () => { const ts = String(Date.now() - 5000); const sec = process.env.AUTH_PASSWORD || "nibrs-page-token-secret"; return Buffer.from(`${ts}:${createHmac("sha256", sec).update(ts).digest("hex").slice(0, 16)}`).toString("base64"); };

async function main() {
  const { NextRequest } = await import("next/server");
  const routes: Record<string, { POST: (r: unknown) => Promise<Response> }> = {
    "/api/query": (await import("../app/api/query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
    "/api/nibrs-query": (await import("../app/api/nibrs-query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
    "/api/shr-query": (await import("../app/api/shr-query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
  };
  const cases = JSON.parse(fs.readFileSync(IN, "utf8")) as { caseId: string; table: string; url: string; body: Record<string, unknown> }[];
  const out: unknown[] = [];
  let ip = 0;
  for (const c of cases) {
    modelCalls = 0;
    ip += 1;
    const logDb = new Database(process.env.QUERY_LOG_DB_PATH!, { readonly: true });
    const before = (logDb.prepare("SELECT COALESCE(MAX(id),0) AS m FROM query_log").get() as { m: number }).m;
    logDb.close();
    const body = { history: [], ...c.body, sessionId: `trace-${c.caseId}`, pageToken: token() };
    const res = await routes[c.url].POST(new NextRequest(`http://localhost${c.url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${ip % 250}.1` }, body: JSON.stringify(body) }));
    const raw = await res.text();
    let text = ""; let sql: string | null = null; let rows = 0;
    if (raw.trimStart().startsWith("{")) { const j = JSON.parse(raw); text = String(j.explanation ?? j.error ?? ""); sql = j.sql || null; rows = Array.isArray(j.rows) ? j.rows.length : 0; }
    else {
      const ev = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const r = [...ev].reverse().find((e: { type: string }) => e.type === "result"); const x = [...ev].reverse().find((e: { type: string }) => e.type === "explanation"); const er = ev.find((e: { type: string }) => e.type === "error");
      text = String(x?.text ?? r?.explanation ?? er?.text ?? ""); sql = r?.sql ?? null; rows = Array.isArray(r?.rows) ? r.rows.length : 0;
    }
    const logDb2 = new Database(process.env.QUERY_LOG_DB_PATH!, { readonly: true });
    const log = logDb2.prepare("SELECT guardrails, sql FROM query_log WHERE id > ? ORDER BY id DESC LIMIT 1").get(before) as { guardrails: string | null; sql: string | null } | undefined;
    logDb2.close();
    const rec = { caseId: c.caseId, table: c.table, status: res.status, modelCalls, sql, rows, guardrails: log?.guardrails ?? null, text: text.replace(/\s+/g, " ").slice(0, 600) };
    out.push(rec);
    console.log(`${c.caseId} [${c.table}] status=${res.status} model=${modelCalls} rows=${rows} | ${String(log?.guardrails ?? "-").slice(0, 120)} | ${rec.text.slice(0, 160)}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`network calls: ${network.length}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
