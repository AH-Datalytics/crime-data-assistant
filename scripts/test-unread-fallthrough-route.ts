/**
 * Option 2 stopgap (audit/presentation-2026-10-20/HOTFIX-UNREAD-PLAN.md; Codex ACCEPT WITH CLARIFICATION,
 * codex-hotfix-plan-ruling.md item 6), handler level.
 *
 * A request whose ONLY recognition problem is words the question check could not read continues to the general model
 * query path, with its existing validators, and every exit after that point carries the note. This runs the real POST
 * handler of each of the four accounting routes on fixture databases, with the model stubbed (no network), and asserts:
 *   - per tab: an unread-only request reaches the model, runs the stubbed SQL through the existing pipeline, returns rows,
 *     and delivers the note naming the words; the log row carries the note and the `unread-fallthrough` tag;
 *   - the unchanged refusals (selected controls): not-recorded and mixed requests, established limitations (court data,
 *     GC-026, SHR overdose) are refused as before with no translation call;
 *   - one successful retry (no SQL, then SQL) and a rejected statement (the validators still apply; the note says no
 *     answer was produced);
 *   - a seeded cache entry for the same question is NOT served (Current, Historical, NIBRS, SHR) and nothing is stored;
 *   - the note survives the initial result and the replacement narrative (Current/Historical SSE);
 *   - the full saved P019 question and the constraint-bearing P025 question reach the model whole;
 *   - SHR's earlier fixed paths (the deterministic shooting branch) do not intercept an eligible request;
 *   - the permission does not leak: a non-class request after (and concurrently with) an eligible one is still refused.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); failed++; process.exitCode = 1; }
}

// Every prepared statement in this process (the rejected-statement checks).
const preparedSql: string[] = [];
{
  const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } }).prototype;
  const realPrepare = proto.prepare;
  proto.prepare = function patchedPrepare(this: unknown, sql: string) { preparedSql.push(sql); return realPrepare.call(this, sql); };
}

// ── The model: stubbed, never reached over the network. Replies are queued per request; the kind of each call is read
// off the system prompt (translation vs narrative), as in scripts/test-shadow-route-equivalence.ts.
type ModelReply = { sql: string | null; explanation: string; title?: string; chartHint?: string; xAxis?: string; yAxis?: string | string[] };
type Call = { kind: "translate" | "explain" | "other"; lastUser: string };
let queue: ModelReply[] = [];
let fallbackReply: ModelReply = { sql: null, explanation: "STUB-TEXT" };
let explainText = "STUB-NARRATIVE";
let explainFailures = 0;
const calls: Call[] = [];
const networkCalls: string[] = [];
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (!url.includes("api.anthropic.com")) { networkCalls.push(url); throw new Error(`network call refused in test: ${url}`); }
  let kind: Call["kind"] = "other";
  let lastUser = "";
  try {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
    const system = String((Array.isArray(body.system) ? body.system.map((s: { text?: string }) => s.text ?? "").join("\n") : body.system) ?? "");
    if (system.includes("SQL query generator") || system.includes("translates natural-language questions")) kind = "translate";
    else if (system.includes("descriptions of crime data query results")) kind = "explain";
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs.filter((m: { role: string }) => m.role === "user").pop();
    lastUser = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  } catch { /* kind stays "other" */ }
  calls.push({ kind, lastUser });
  // Forced narrative failures (build ruling item 3): a 400 is not retried by the SDK, so each failure is one route attempt.
  if (kind === "explain" && explainFailures > 0) {
    explainFailures -= 1;
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stub narrative failure" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const reply = kind === "translate" ? (queue.shift() ?? fallbackReply) : null;
  const text = kind === "explain"
    ? explainText
    : JSON.stringify({ sql: reply?.sql ?? null, explanation: reply?.explanation ?? "STUB-TEXT", title: reply?.title ?? "", chartHint: reply?.chartHint ?? "none", xAxis: reply?.xAxis ?? "", yAxis: reply?.yAxis ?? "" });
  return new Response(JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof globalThis.fetch;
const translations = () => calls.filter((c) => c.kind === "translate");

// ── Fixtures: the operation-taxonomy schemas, seeded with Austin, TX / Texas 2019-2022.
const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "unread-fallthrough-"));
function open(name: string, ddl: string): Database.Database {
  const db = new Database(path.join(DIR, name));
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(DATA_DIR, ddl), "utf8"));
  return db;
}
{
  const db = open("crime_data.db", "crime_data.ddl.sql");
  db.prepare("INSERT INTO agencies (ori, agency, state, type, total_months, national_sample) VALUES (?,?,?,?,?,?)").run("TX2270100", "Austin", "TX", "City", 96, 1);
  const am = db.prepare("INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)");
  const ap = db.prepare("INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)");
  db.prepare("INSERT INTO historical_agency (ori, agency, state, type) VALUES (?,?,?,?)").run("TX2270100", "Austin", "TX", "City");
  const hac = db.prepare("INSERT INTO historical_agency_crime (ori, year, population, murder, robbery) VALUES (?,?,?,?,?)");
  const hsn = db.prepare("INSERT INTO historical_state_national (state, year, population, murder, robbery) VALUES (?,?,?,?,?)");
  for (let year = 2019; year <= 2022; year += 1) {
    for (let month = 1; month <= 12; month += 1) for (const [offense, n] of [["Murder", 3], ["Robbery", 40]] as const) am.run("TX2270100", "Austin", "TX", "City", year, month, offense, n);
    ap.run("TX2270100", year, 950000);
    hac.run("TX2270100", year, 950000, 36, 480);
    hsn.run("Texas", year, 29000000, 1900 + year - 2019, 30000);
    hsn.run("United States", year, 330000000, 17000 + year - 2019, 250000);
  }
  db.close();
}
{
  const db = open("nibrs.db", "nibrs.ddl.sql");
  const v = db.prepare("INSERT INTO summary_victim_state_monthly (state, year, month, ucr_offense_code, victim_count) VALUES (?,?,?,?,?)");
  for (let year = 2019; year <= 2022; year += 1) for (let month = 1; month <= 12; month += 1) v.run("TX", year, month, "09A", 150);
  db.close();
}
{
  const db = open("shr.db", "shr.ddl.sql");
  const I = db.prepare("INSERT INTO incidents (id, year, month, state, state_name, ori, agency, population, division, homicide_type, situation, weapon, weapon_group, relationship, relationship_group, circumstance, circumstance_group, sub_circumstance, action_type, incident_num, off_age, off_age_num, off_sex, off_race, off_ethnicity, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const V = db.prepare("INSERT INTO victims (id, incident_id, victim_num, age, age_num, sex, race, ethnicity) VALUES (?,?,?,?,?,?,?,?)");
  const ID = db.prepare("INSERT INTO shr_agency_identity (ori, state, canonical_agency, agency_type, search_key, source_agency_names, source_agency_types, nibrs_city, nibrs_agency_type, incident_count, first_year, last_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const AL = db.prepare("INSERT INTO shr_agency_alias (alias, alias_key, ori, state, canonical_agency, agency_type, source) VALUES (?,?,?,?,?,?,?)");
  let id = 1;
  for (let year = 2019; year <= 2022; year += 1) for (let month = 1; month <= 12; month += 1) {
    for (const [weapon, group] of [["Handgun", "Firearm"], ["Knife", "Knife/Cutting"]]) {
      I.run(id, year, month, "TX", "Texas", "TX2270100", "Austin", 950000, "div", "Murder", "Single victim/single offender", weapon, group,
        "Acquaintance", "Acquaintance", "Argument", "Argument", null, "Normal", 1, "30", 30, "M", "W", "N", "City");
      V.run(id, id, 1, "25", 25, "M", "B", "N");
      id += 1;
    }
  }
  ID.run("TX2270100", "TX", "Austin", "City", "AUSTIN", "Austin", "City", "AUSTIN", "City", 96, 2019, 2022);
  AL.run("Austin", "AUSTIN", "TX2270100", "TX", "Austin", "City", "seed");
  db.close();
}
for (const [name, ddl] of [["query_log.db", "query_log.ddl.sql"], ["nibrs_rollups.db", "rollup.ddl.sql"], ["hate_crime.db", "hc.ddl.sql"]]) open(name, ddl).close();
process.env.SHR_DB_PATH = path.join(DIR, "shr.db");
process.env.RTCI_DB_PATH = path.join(DIR, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(DIR, "query_log.db");
process.env.NIBRS_DB_PATH = path.join(DIR, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(DIR, "nibrs_rollups.db");
process.env.HATE_CRIME_DB_PATH = path.join(DIR, "hate_crime.db");
process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
delete process.env.PROOF_MODE;

function pageToken(): string {
  const ts = String(Date.now() - 5000);
  const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";
  return Buffer.from(`${ts}:${createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16)}`).toString("base64");
}
let ip = 0;
const nextIp = () => { ip += 1; return `10.${Math.floor(ip / 250) % 250}.${ip % 250}.9`; };

type Tab = "current" | "historical" | "nibrs" | "shr";
type Answer = { sql: string | null; explanation: string; rows: unknown[]; title: string; texts: string[]; events: Record<string, unknown>[]; log: { response: string | null; guardrails: string | null } | null };

const NOTE = /Note: the question check did not understand/;
const ANSWERED = /We used the general query path, which may not have applied those parts\. The usual query safety checks still ran\. Check that the answer matches your request\./;
const NOT_ANSWERED = /We tried the general query path; no answer was produced\./;
const TAG = "request-accounting:unread-fallthrough";

async function main() {
  const routes = {
    query: await import("../app/api/query/route"),
    nibrs: await import("../app/api/nibrs-query/route"),
    shr: await import("../app/api/shr-query/route"),
  };
  const { NextRequest } = await import("next/server");
  const { setCache, getCached, __resetResponseCacheForTests } = await import("../lib/response-cache");
  const { CURRENT_CACHE_TAB } = await import("../lib/current-request-accounting");
  const { SHR_OVERDOSE_NOT_RECORDED } = await import("../lib/shr-request-accounting");
  const logDb = () => new Database(path.join(DIR, "query_log.db"), { readonly: true });

  const ask = async (tab: Tab, question: string, replies: ModelReply[] = [], history: { role: string; content: string }[] = []): Promise<Answer> => {
    queue = [...replies];
    calls.length = 0;
    const maxIdBefore = (() => { const d = logDb(); try { return (d.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM query_log").get() as { m: number }).m; } finally { d.close(); } })();
    const url = tab === "nibrs" ? "http://localhost/api/nibrs-query" : tab === "shr" ? "http://localhost/api/shr-query" : "http://localhost/api/query";
    const body = { question, history, sessionId: `unread-${Date.now()}`, pageToken: pageToken(), ...(tab === "historical" ? { mode: "historical" } : {}) };
    const req = new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() }, body: JSON.stringify(body) });
    const route = tab === "nibrs" ? routes.nibrs : tab === "shr" ? routes.shr : routes.query;
    const res = await route.POST(req);
    let answer: Omit<Answer, "log">;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const raw = await res.text();
      const events = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
      const result = [...events].reverse().find((e) => e.type === "result") ?? {};
      const replacement = [...events].reverse().find((e) => e.type === "explanation");
      const error = events.find((e) => e.type === "error");
      const texts = events.map((e) => String(e.explanation ?? e.text ?? "")).filter(Boolean);
      answer = {
        sql: (result.sql as string | null) ?? null,
        explanation: String(replacement?.text ?? result.explanation ?? error?.text ?? ""),
        rows: Array.isArray(result.rows) ? result.rows : [],
        title: String(result.title ?? ""), texts, events,
      };
    } else {
      const j = await res.json() as Record<string, unknown>;
      const explanation = String(j.explanation ?? j.error ?? "");
      answer = { sql: (j.sql as string | null) ?? null, explanation, rows: Array.isArray(j.rows) ? j.rows : [], title: String(j.title ?? ""), texts: [explanation], events: [j] };
    }
    const d = logDb();
    try {
      const log = d.prepare("SELECT response, guardrails FROM query_log WHERE id > ? ORDER BY id DESC LIMIT 1").get(maxIdBefore) as Answer["log"] | undefined;
      return { ...answer, log: log ?? null };
    } finally { d.close(); }
  };
  const show = (a: Answer) => `sql=${String(a.sql).slice(0, 160)} rows=${a.rows.length} | ${a.explanation.slice(0, 300)} | log.guardrails=${a.log?.guardrails ?? "-"}`;

  const fellThrough = (a: Answer, words: string[], answered: boolean) => {
    assert.ok(translations().length >= 1, `the model was asked to translate (${calls.map((c) => c.kind).join(",")}); ${show(a)}`);
    assert.match(a.explanation, NOTE, show(a));
    for (const w of words) assert.ok(a.explanation.includes(`"${w}"`), `the note names "${w}": ${a.explanation}`);
    assert.match(a.explanation, answered ? ANSWERED : NOT_ANSWERED, show(a));
    if (answered) assert.ok(a.rows.length > 0, `rows were returned: ${show(a)}`);
    else assert.equal(a.rows.length, 0, show(a));
    assert.ok(a.log, "a log row was written");
    assert.match(String(a.log!.response), NOTE, `the log row carries the note: ${a.log!.response}`);
    assert.ok(String(a.log!.guardrails).split(",").includes(TAG), `the log row carries the tag: ${a.log!.guardrails}`);
  };
  const refusedUnchanged = (a: Answer) => {
    assert.equal(translations().length, 0, `no translation call (${calls.map((c) => c.kind).join(",")}); ${show(a)}`);
    assert.equal(a.rows.length, 0, show(a));
    assert.doesNotMatch(a.explanation, NOTE, show(a));
    assert.ok(!String(a.log?.guardrails ?? "").includes(TAG), `no fallback tag: ${a.log?.guardrails}`);
  };

  // Stub SQL per tab, against the fixtures.
  const SQL = {
    current: "SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Austin' AND state = 'TX' AND offense = 'Murder' AND year BETWEEN 2019 AND 2022 GROUP BY year ORDER BY year",
    historical: "SELECT year, murder FROM historical_state_national WHERE state = 'Texas' AND year = 2020",
    nibrs: "SELECT year, SUM(victim_count) AS murder_victims FROM summary_victim_state_monthly WHERE state = 'TX' AND ucr_offense_code = '09A' AND year = 2020 GROUP BY year",
    shr: "SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'TX' AND i.homicide_type = 'Murder' AND i.year = 2020 GROUP BY i.year",
  } as const;
  const Q = {
    current: "how many murders in Austin, TX each year from 2019 to 2022 thx",
    historical: "murders in Texas in 2020 thx",
    nibrs: "murders in Texas in 2020 thx",
    shr: "murders in Texas in 2020 thx",
  } as const;
  const reply = (tab: Tab): ModelReply => ({ sql: SQL[tab], explanation: "STUB-EXPLANATION", title: "Stub title", chartHint: "none", xAxis: "year", yAxis: tab === "shr" ? [] : "" });

  console.log("\nper tab: an unread-only request falls through with the note");
  for (const tab of ["current", "historical", "nibrs", "shr"] as const) {
    await check(`${tab}: "${Q[tab]}" reaches the model, returns rows, and delivers the note naming "thx"`, async () => {
      const a = await ask(tab, Q[tab], [reply(tab)]);
      fellThrough(a, ["thx"], true);
      assert.ok(translations()[0].lastUser.includes(Q[tab]), `the whole question reached the model: ${translations()[0].lastUser.slice(0, 300)}`);
    });
  }

  console.log("\nthe unchanged refusals (selected controls): no translation call");
  const controls: [Tab, string, RegExp | string | null][] = [
    ["shr", "immigrant victims of murder in Chicago in 2020", null],
    ["historical", "immigrant victims of murder in Chicago in 2020", null],
    ["current", "immigrant victims of murder in Chicago in 2020", null],
    ["shr", "Number of overdose deaths in NJ since 1990", SHR_OVERDOSE_NOT_RECORDED],
    ["shr", "arrest rate by race for robbery in Chicago", /population denominators/],
    ["current", "conviction rates in Houston", null],
    ["nibrs", "conviction rates in Houston", null],
    ["historical", "how many murder victims in Texas each year from 2019 to 2022 thx", null],
    // Finding 1 (2026-10-21): overdose deaths and immigration status were unread words on these tabs, so they would have
    // fallen through; they are now not-recorded topics and refused by name.
    ["nibrs", "Number of overdose deaths in NJ since 1990", /doesn't record overdose deaths/],
    ["historical", "Number of overdose deaths in NJ since 1990", /doesn't record overdose deaths/],
    ["current", "Number of overdose deaths in NJ since 1990", /doesn't track overdose deaths/],
    ["nibrs", "immigrant victims of murder in Chicago in 2020", /doesn't record immigration or citizenship status/],
    ["historical", "crimes by undocumented immigrants in Texas in 2022", /doesn't record immigration or citizenship status/],
    ["current", "crimes by undocumented immigrants in Texas in 2022", /doesn't track immigration or citizenship status/],
  ];
  for (const [tab, q, expected] of controls) {
    await check(`${tab}: "${q}" is refused as before`, async () => {
      const a = await ask(tab, q, [reply(tab)]);
      refusedUnchanged(a);
      if (typeof expected === "string") assert.equal(a.explanation, expected);
      else if (expected) assert.match(a.explanation, expected, a.explanation);
    });
  }

  console.log("\nretry and validators");
  await check("current: one no-SQL reply then SQL -> the retry answers, with the note", async () => {
    const a = await ask("current", "murders in Austin, TX in 2021 thx", [{ sql: null, explanation: "I can help with that." }, { ...reply("current"), sql: SQL.current.replace("BETWEEN 2019 AND 2022", "= 2021") }]);
    assert.ok(translations().length >= 2, `a retry happened (${translations().length})`);
    fellThrough(a, ["thx"], true);
  });
  await check("nibrs: one no-SQL reply then SQL -> the retry answers, with the note", async () => {
    const a = await ask("nibrs", "murders in Texas in 2021 thx", [{ sql: null, explanation: "I can help with that." }, { ...reply("nibrs"), sql: SQL.nibrs.replace("= 2020", "= 2021") }]);
    assert.ok(translations().length >= 2, `a retry happened (${translations().length})`);
    fellThrough(a, ["thx"], true);
  });
  for (const tab of ["current", "historical", "nibrs", "shr"] as const) {
    await check(`${tab}: a statement the validators reject is not executed; the note says no answer was produced`, async () => {
      const bad: ModelReply = { sql: "DELETE FROM query_log", explanation: "STUB", title: "x" };
      preparedSql.length = 0;
      const a = await ask(tab, `murders in Texas in 2019 asap`, [bad, bad, bad, bad]);
      assert.ok(translations().length >= 1, "the model was asked");
      assert.equal(a.rows.length, 0, show(a));
      // NIBRS and SHR echo the rejected text in their error payload (pre-existing, unchanged since 5f9e972); what matters
      // is that it is never prepared or run.
      assert.ok(!preparedSql.some((q) => /^\s*DELETE/i.test(q)), "the rejected statement was never prepared");
      assert.match(a.explanation, NOTE, show(a));
      assert.match(a.explanation, NOT_ANSWERED, show(a));
      const d = logDb();
      try { assert.ok((d.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n > 0, "query_log was not deleted"); } finally { d.close(); }
    });
  }

  console.log("\ncache: a seeded entry for the same question is not served, and nothing is stored");
  // A VALID statement for the tab with a marker column, so a cache hit would execute and be visible (an invalid seeded
  // statement is recovered through the model and would hide the hit).
  const { cacheValiditySignature } = await import("../lib/proof-cache-validity");
  const seededFor = (tab: Tab) => ({ sql: SQL[tab].replace(/BETWEEN 2019 AND 2022|= 2020/, "= 2022").replace(/ AS [a-z_]+ FROM/, " AS poisoned_marker FROM"), explanation: "POISONED-CACHE", title: "Poisoned" });
  const cacheCases: [Tab, string, string][] = [
    ["current", "murders in Austin, TX in 2022 kindly", CURRENT_CACHE_TAB],
    ["historical", "murders in Texas in 2022 kindly", (await import("../lib/historical-request-accounting")).HISTORICAL_CACHE_TAB],
    ["nibrs", "murders in Texas in 2022 kindly", (await import("../lib/nibrs-request-accounting")).NIBRS_CACHE_TAB],
    ["shr", "murders in Texas in 2022 kindly", "shr"],
  ];
  for (const [tab, q, cacheTab] of cacheCases) {
    await check(`${tab}: a seeded cache entry is bypassed and no fallback answer is stored`, async () => {
      __resetResponseCacheForTests();
      const validity = cacheValiditySignature(tab, null);
      assert.equal(validity, undefined, "no proof enforcement in this suite, so the route keys the cache without a signature");
      setCache(q, cacheTab, seededFor(tab), validity);
      assert.ok(getCached(q, cacheTab, validity), "the seeded entry is readable under the route key");
      const a = await ask(tab, q, [{ ...reply(tab), sql: SQL[tab].replace(/BETWEEN 2019 AND 2022|= 2020/, "= 2022") }]);
      assert.doesNotMatch(JSON.stringify(a.events), /POISONED|poisoned_marker/, "the cached answer was not served");
      fellThrough(a, ["kindly"], true);
      __resetResponseCacheForTests();
      await ask(tab, q, [{ ...reply(tab), sql: SQL[tab].replace(/BETWEEN 2019 AND 2022|= 2020/, "= 2022") }]);
      assert.equal(getCached(q, cacheTab), null, "the fallback answer was not stored");
    });
  }

  console.log("\nnote survival: initial result and replacement narrative (Current/Historical SSE)");
  for (const tab of ["current", "historical"] as const) {
    await check(`${tab}: every delivered result and replacement text carries the note exactly once`, async () => {
      const a = await ask(tab, tab === "current" ? "murders in Austin, TX in 2020 lol" : "murders in Texas in 2021 lol", [{ ...reply(tab), sql: SQL[tab].replace(/BETWEEN 2019 AND 2022|= 2020/, tab === "current" ? "= 2020" : "= 2021") }]);
      const factual = a.events.filter((e) => e.type === "result" || e.type === "explanation");
      assert.ok(factual.some((e) => e.type === "result"), "a result event was delivered");
      assert.ok(factual.some((e) => e.type === "explanation"), "a replacement narrative event was delivered (the case this check exists for)");
      for (const e of factual) {
        const t = String(e.type === "result" ? e.explanation : e.text);
        assert.equal((t.match(/Note: the question check did not understand/g) ?? []).length, 1, `${e.type} carries the note once: ${t}`);
      }
      console.log(`        events: ${a.events.map((e) => e.type).join(",")}`);
    });
  }

  console.log("\nsaved cases");
  await check("P019 (full saved question, Current): reaches the model whole, with the note naming every unread part", async () => {
    const q = "Chico California -- 2005-2024. Violent and Property cirme totals an drates per 1,000. I want columns of Year, Population, Violent Crimes, Violent crimes rate per 100,000, property crimes, property crimes rate per 1000, total part 1 crimes, total rate per 1000.";
    const a = await ask("current", q, [reply("current")]);
    assert.ok(translations().length >= 1, `the model was asked: ${show(a)}`);
    assert.ok(translations()[0].lastUser.includes("I want columns of Year, Population"), "the requested columns reached the model");
    assert.match(a.explanation, NOTE, show(a));
    for (const w of ["cirme", "an drates", "I want columns of Year, Population,"]) assert.ok(a.explanation.includes(`"${w}"`), `names "${w}": ${a.explanation}`);
  });
  await check("P025 (constraint-bearing, NIBRS): the condition reaches the model whole; the note names it", async () => {
    const q = "How many burglaries happened at convenience stores in Texas last year?";
    const a = await ask("nibrs", q, [{ ...reply("nibrs"), sql: SQL.nibrs }]);
    assert.ok(translations().length >= 1, `the model was asked: ${show(a)}`);
    assert.ok(translations()[0].lastUser.includes("convenience stores"), "the condition reached the model");
    assert.match(a.explanation, NOTE, show(a));
    assert.ok(a.explanation.includes(`"happened at convenience stores in"`), a.explanation);
    console.log(`        P025 delivered: ${show(a)}`);
  });

  console.log("\nSHR earlier fixed paths");
  await check("shr: an eligible shootings question is not taken by the deterministic shooting branch", async () => {
    const a = await ask("shr", "fatal shootings in Austin, TX in 2020 thx", [{ ...reply("shr"), sql: SQL.shr.replace("i.homicide_type = 'Murder'", "i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm'") }]);
    assert.ok(translations().length >= 1, `the model was asked: ${show(a)}`);
    assert.match(a.explanation, NOTE, show(a));
  });

  console.log("\nno leak of the permission");
  await check("a non-class request right after an eligible one is still refused with no translation", async () => {
    await ask("current", "murders in Austin, TX in 2019 thx", [reply("current")]);
    const a = await ask("current", "conviction rates in Houston", [reply("current")]);
    refusedUnchanged(a);
  });
  await check("concurrent eligible and non-class requests keep their own decisions", async () => {
    queue = []; calls.length = 0;
    fallbackReply = reply("nibrs");
    const mk = (question: string) => routes.nibrs.POST(new NextRequest("http://localhost/api/nibrs-query", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextIp() }, body: JSON.stringify({ question, history: [], pageToken: pageToken() }) }));
    const [r1, r2] = await Promise.all([mk("murders in Texas in 2020 pls"), mk("conviction rates in Houston")]);
    fallbackReply = { sql: null, explanation: "STUB-TEXT" };
    const [j1, j2] = [await r1.json() as { explanation: string }, await r2.json() as { explanation: string; rows: unknown[] }];
    assert.match(j1.explanation, NOTE, j1.explanation);
    assert.doesNotMatch(j2.explanation, NOTE, j2.explanation);
    assert.equal(j2.rows.length, 0);
  });

  // ── Build ruling (codex-hotfix-build-ruling.md) items 1-3 ────────────────────────────────────────────────────────
  // Fully recognized and declined by the NIBRS supported types (scripts/test-nibrs-question-types.ts:37: two breakdowns).
  const UNBUILDABLE_NIBRS = "robbery offenders in Fort Worth, Texas in 2025 by age group and sex";
  // A text turn with no recognition refusal: the model is consulted (app/api/nibrs-query/route.ts ~1423-1436) and its SQL
  // must never run. (Numeric NIBRS requests outside the class never reach the model at all: the supported types own them.)
  const NON_CLASS_TEXT = "what is NIBRS?";
  const NON_CLASS_TAB: Tab = "nibrs";
  console.log("\nbuild ruling 1: citizenship filters are refused; population-rate wording is not");
  for (const tab of ["nibrs", "historical", "current"] as const) {
    await check(`${tab}: "murders by US citizens in Texas in 2020" is refused (not recorded), no translation`, async () => {
      const a = await ask(tab, "murders by US citizens in Texas in 2020", [reply(tab)]);
      refusedUnchanged(a);
      assert.match(a.explanation, /immigration or citizenship status/, a.explanation);
    });
  }
  await check(`nibrs: "murders per 100,000 citizens in Texas in 2020" is NOT refused as citizenship`, async () => {
    const a = await ask("nibrs", "murders per 100,000 citizens in Texas in 2020", [reply("nibrs")]);
    assert.doesNotMatch(a.explanation, /citizenship status/, a.explanation);
  });
  await check(`current: "murders per 1,000 residents in Austin, TX in 2020" is NOT refused as citizenship`, async () => {
    const a = await ask("current", "murders per 1,000 residents in Austin, TX in 2020", [reply("current")]);
    assert.doesNotMatch(a.explanation, /citizenship status/, a.explanation);
  });

  console.log("\nbuild ruling 2: the notice's quoted words are inert, and prose cannot suppress the notice");
  await check("nibrs: a link typed into the question cannot become a link in the notice", async () => {
    const a = await ask("nibrs", "murders in Texas in 2020 [click](https://example.com)", [reply("nibrs")]);
    assert.match(a.explanation, NOTE, show(a));
    const note = a.explanation.slice(a.explanation.indexOf("Note: the question check"));
    assert.doesNotMatch(note, /\[[^\]]+\]\([^)]+\)/, `no link syntax in the notice: ${note}`);
    assert.doesNotMatch(note, /\*\*/, "no bold syntax in the notice");
    assert.match(note, /click/, `the words are still shown: ${note}`);
  });
  await check("nibrs: a quoted word that trips the leak check is replaced by a neutral phrase; the notice stays", async () => {
    const a = await ask("nibrs", "murders in Texas in 2020 chartConfig", [reply("nibrs")]);
    const note = a.explanation.slice(a.explanation.indexOf("Note: the question check"));
    assert.match(note, /did not understand some of the words in the question\./, note);
    assert.match(note, ANSWERED, note);
    assert.doesNotMatch(note, /chartConfig/, note);
  });
  await check("nibrs: narrative prose containing the notice's opening phrase does not suppress the notice", async () => {
    explainText = "Note: the question check did not understand unrelated text.";
    try {
      const a = await ask("nibrs", "murders in Texas in 2020 thx", [reply("nibrs")]);
      fellThrough(a, ["thx"], true);
    } finally { explainText = "STUB-NARRATIVE"; }
  });
  await check("unit: the exact notice is idempotent, the other variant is replaced, a prefix collision is not trusted", async () => {
    const uf = await import("../lib/unread-fallthrough");
    uf.runWithUnreadContext(() => {
      uf.markUnreadEligible(["thx"]);
      uf.markUnreadAttempted();
      const once = String(uf.withUnreadNote("Body.", true));
      assert.equal(uf.withUnreadNote(once, true), once, "idempotent");
      const flipped = String(uf.withUnreadNote(once, false));
      assert.equal((flipped.match(/Note: the question check/g) ?? []).length, 1, flipped);
      assert.match(flipped, NOT_ANSWERED);
      const collided = String(uf.withUnreadNote("Note: the question check did not understand unrelated text", true));
      assert.match(collided, /"thx"/, collided);
      assert.match(collided, ANSWERED, collided);
    });
  });

  console.log("\nbuild ruling 3: narrative failure, both cache stores, follow-up and gate controls");
  // A failed narrative model call does not throw: lib/explain.ts generateExplanation catches it and returns its own
  // fallback sentence, so the user-visible failure goes through the ordinary store at app/api/query/route.ts ~3789. The
  // retry and both-failed branches (~3796-3870) run only when the route's own post-processing throws, which a stubbed
  // model cannot cause; their store is covered by the source check below and a separate mutation run (BUILD.md).
  for (const tab of ["current", "historical"] as const) {
    await check(`${tab}: the narrative model call fails -> the fallback narrative carries the note; log note and tag; nothing cached`, async () => {
      __resetResponseCacheForTests();
      const q = tab === "current" ? "murders in Austin, TX in 2019 pls" : "murders in Texas in 2019 pls";
      explainFailures = 1;
      try {
        const a = await ask(tab, q, [{ ...reply(tab), sql: SQL[tab].replace(/BETWEEN 2019 AND 2022|= 2020/, "= 2019") }]);
        assert.equal(calls.filter((c) => c.kind === "explain").length, 1, `one failed narrative call (${calls.map((c) => c.kind).join(",")})`);
        assert.equal(explainFailures, 0, "the forced failure was consumed");
        assert.doesNotMatch(a.explanation, /STUB-NARRATIVE/, "the stub narrative was not used");
        fellThrough(a, ["pls"], true);
        assert.equal(getCached(q, tab === "current" ? CURRENT_CACHE_TAB : (await import("../lib/historical-request-accounting")).HISTORICAL_CACHE_TAB), null, "nothing cached");
      } finally { explainFailures = 0; }
    });
  }
  await check("source: every Current/Historical cache store is excluded for a fallback request (success and catch branches)", () => {
    const src = fs.readFileSync("app/api/query/route.ts", "utf8");
    const stores = [...src.matchAll(/^\s*if \(([^\n]*)\) \{\n\s*setCache\(question, tab === "historical"/gm)].map((m) => m[1]);
    assert.equal(stores.length, 2, `two guarded store sites (${stores.length})`);
    for (const cond of stores) assert.match(cond, /!unreadEligible\(\)/, cond);
    assert.equal((src.match(/setCache\(/g) ?? []).length, 2, "no other store site");
  });
  await check("nibrs: an effective follow-up the follow-up check declines is unchanged (no translation, no notice)", async () => {
    const history = [
      { role: "user", content: "fentanyl seizures in Texas in 2020" },
      { role: "assistant", content: "NIBRS doesn't record fentanyl as its own drug type." },
    ];
    const a = await ask("nibrs", "what about 2021 thx?", [reply("nibrs")], history);
    refusedUnchanged(a);
    assert.match(String(a.log?.guardrails), /request-accounting-owner:followup/, String(a.log?.guardrails));
  });
  await check("nibrs: a fully recognized request the supported types decline is unchanged (no translation, no notice)", async () => {
    const a = await ask("nibrs", UNBUILDABLE_NIBRS, [reply("nibrs")]);
    console.log(`        recognized-but-unbuildable: ${show(a)}`);
    refusedUnchanged(a);
  });
  await check("a non-class request the model is consulted for never runs the model's SQL (the gate still applies)", async () => {
    preparedSql.length = 0;
    const a = await ask(NON_CLASS_TAB, NON_CLASS_TEXT, [{ ...reply(NON_CLASS_TAB), sql: "SELECT 424242 AS gate_probe FROM summary_victim_state_monthly" }]);
    console.log(`        non-class gate: translations=${translations().length} ${show(a)}`);
    assert.ok(translations().length >= 1, "the model WAS consulted (otherwise this control proves nothing)");
    assert.ok(!preparedSql.some((q) => /gate_probe/.test(q)), "the model's statement was never prepared");
    assert.doesNotMatch(a.explanation, NOTE, show(a));
    assert.ok(!String(a.log?.guardrails ?? "").includes(TAG));
  });

  await check("offline: no network call other than the stubbed model", () => assert.deepEqual(networkCalls, []));
}

main()
  .catch((e) => { console.log(`  FAIL  suite crashed: ${(e as Error).stack}`); failed++; process.exitCode = 1; })
  .finally(() => {
    console.log(`\nunread fall-through (route): ${passed} passed, ${failed} failed`);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows keeps the handles open; harmless */ }
    process.exit(failed ? 1 : 0);
  });
