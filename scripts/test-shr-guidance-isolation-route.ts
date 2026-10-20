/**
 * Answer batch A (2026-10-20; plan audit/answer-batch-a-2026-10-20/PLAN.md + PLAN-r2.md), handler level.
 *
 * GC-026 and GC-078: when a Homicide Reports question named a city, the route pushed its "[SYSTEM: Deterministic SHR
 * geography resolution ...]" instruction onto `history` itself (promptHistory aliased it), and request accounting then
 * read that instruction as an earlier USER turn: GC-026 refused "using the requested place" as a weapon, and GC-078's
 * refusal quoted "[SYSTEM:" and was blanked by the leak firewall to "The requested results are shown above." over zero
 * rows. GC-106: overdose deaths were answered as drug-weapon homicides.
 *
 * This runs the real SHR POST handler on fixture databases, with the model stubbed (no network) and every prepared
 * statement observed, and asserts each final response:
 *   GC-026  the established demographic-rate/source limitation, no SQL, no rows, no instruction text;
 *   GC-078  the violent/property/both clarification, no rows;
 *   GC-106  the overdose limitation, no SQL, no rows, no number, no Narcotics/Drugs statement executed;
 * and that a city question after a real earlier question is not refused for instruction text (no-transform branch), a
 * transform follow-up still answers, and a real earlier restriction is still carried into a follow-up.
 * A source guard ties both affected routes to building `promptHistory` as a new array.
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

// Every prepared statement in this process.
const preparedSql: string[] = [];
{
  const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } }).prototype;
  const realPrepare = proto.prepare;
  proto.prepare = function patchedPrepare(this: unknown, sql: string) { preparedSql.push(sql); return realPrepare.call(this, sql); };
}

// The model: stubbed, counted, never reached over the network. Any other network call fails the suite.
let modelCalls = 0;
const networkCalls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (!url.includes("api.anthropic.com")) { networkCalls.push(url); throw new Error(`network call refused in test: ${url}`); }
  modelCalls += 1;
  return new Response(JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: JSON.stringify({ sql: null, explanation: "STUB-MODEL-REPLY", title: "", chartHint: "none", xAxis: "", yAxis: "" }) }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof globalThis.fetch;

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shr-guidance-"));
function open(name: string, ddl: string): Database.Database {
  const db = new Database(path.join(DIR, name));
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(DATA_DIR, ddl), "utf8"));
  return db;
}

// SHR: Chicago, IL and Mesa, AZ as resolvable cities with firearm and knife murders, 2017-2025.
{
  const db = open("shr.db", "shr.ddl.sql");
  const I = db.prepare("INSERT INTO incidents (id, year, month, state, state_name, ori, agency, population, division, homicide_type, situation, weapon, weapon_group, relationship, relationship_group, circumstance, circumstance_group, sub_circumstance, action_type, incident_num, off_age, off_age_num, off_sex, off_race, off_ethnicity, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const V = db.prepare("INSERT INTO victims (id, incident_id, victim_num, age, age_num, sex, race, ethnicity) VALUES (?,?,?,?,?,?,?,?)");
  const ID = db.prepare("INSERT INTO shr_agency_identity (ori, state, canonical_agency, agency_type, search_key, source_agency_names, source_agency_types, nibrs_city, nibrs_agency_type, incident_count, first_year, last_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const AL = db.prepare("INSERT INTO shr_agency_alias (alias, alias_key, ori, state, canonical_agency, agency_type, source) VALUES (?,?,?,?,?,?,?)");
  let id = 1;
  for (const [ori, name, st, stName, pop] of [["ILCPD0000", "Chicago", "IL", "Illinois", 2700000], ["AZ0070500", "Mesa", "AZ", "Arizona", 500000]] as const) {
    for (let year = 2017; year <= 2025; year += 1) for (let month = 1; month <= 12; month += 1) {
      for (const [weapon, group] of [["Handgun", "Firearm"], ["Knife", "Knife/Cutting"]]) {
        I.run(id, year, month, st, stName, ori, name, pop, "div", "Murder", "Single victim/single offender", weapon, group,
          "Acquaintance", "Acquaintance", "Argument", "Argument", null, "Normal", 1, "30", 30, "M", "W", "N", "City");
        V.run(id, id, 1, "25", 25, "M", "B", "N");
        id += 1;
      }
    }
    const key = name.toUpperCase();
    ID.run(ori, st, name, "City", key, name, "City", key, "City", 216, 2017, 2025);
    AL.run(name, key, ori, st, name, "City", "seed");
  }
  db.close();
}
for (const [name, ddl] of [["crime_data.db", "crime_data.ddl.sql"], ["query_log.db", "query_log.ddl.sql"], ["nibrs.db", "nibrs.ddl.sql"], ["nibrs_rollups.db", "rollup.ddl.sql"], ["hate_crime.db", "hc.ddl.sql"]]) open(name, ddl).close();
process.env.SHR_DB_PATH = path.join(DIR, "shr.db");
process.env.RTCI_DB_PATH = path.join(DIR, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(DIR, "query_log.db");
process.env.NIBRS_DB_PATH = path.join(DIR, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(DIR, "nibrs_rollups.db");
process.env.HATE_CRIME_DB_PATH = path.join(DIR, "hate_crime.db");
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-not-used";

function pageToken(): string {
  const ts = String(Date.now() - 5000);
  const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";
  return Buffer.from(`${ts}:${createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16)}`).toString("base64");
}
let ip = 0;
type Reply = { sql: string | null; explanation: string; rows: unknown[]; title?: string };

async function main() {
  const route = await import("../app/api/shr-query/route");
  const { NextRequest } = await import("next/server");
  const { selectNoSqlRefusal } = await import("../lib/refusal-safety");
  const { SHR_OVERDOSE_NOT_RECORDED } = await import("../lib/shr-request-accounting");
  // What request accounting is actually given (lib/accounting-input-probe.ts), per request.
  type Input = { source: string; question: string; earlierTurns: string[] };
  let inputs: Input[] = [];
  (globalThis as { __cdaAccountingInputRecorder?: (i: Input) => void }).__cdaAccountingInputRecorder = (i) => { inputs.push(i); };
  type Asked = Reply & { input: Input; handlerBody: { history: { role: string; content: string }[] }; bodyBefore: string };
  const ask = async (question: string, history: { role: string; content: string }[] = []): Promise<Asked> => {
    inputs = [];
    // The handler is given THIS object from req.json(), so a mutation of it by the handler is observable here.
    const handlerBody = { question, history: history.map((m) => ({ ...m })), sessionId: `batch-a-${Date.now()}`, pageToken: pageToken() };
    const bodyBefore = JSON.stringify(handlerBody.history);
    const req = new NextRequest("http://localhost/api/shr-query", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${(ip += 1) % 250}.1` }, body: JSON.stringify(handlerBody),
    });
    Object.defineProperty(req, "json", { value: async () => handlerBody });
    const res = await route.POST(req);
    const reply = await res.json() as Reply;
    assert.equal(inputs.length, 1, `accounting ran once (${inputs.length})`);
    return { ...reply, input: inputs[0], handlerBody, bodyBefore };
  };
  const bodyUnchanged = (a: Asked) => assert.equal(JSON.stringify(a.handlerBody.history), a.bodyBefore, "the handler's own request body history is unchanged");
  const noInstructionInInput = (a: Asked) => {
    assert.doesNotMatch([a.input.question, ...a.input.earlierTurns].join("\n"), /\[SYSTEM|Deterministic SHR geography|requested place labels/i, "accounting input carries no app instruction");
  };
  const noInstructionText = (r: Reply) => {
    const all = `${r.explanation} ${r.title ?? ""}`;
    assert.doesNotMatch(all, /\[SYSTEM|using the requested place|Deterministic|shown above/i, all);
  };

  await check("GC-026: the established demographic-rate and source limitation; no SQL, rows or instruction text", async () => {
    const q = "arrest rate by race for robbery in Chicago";
    const r = await ask(q);
    noInstructionText(r);
    noInstructionInInput(r);
    assert.deepEqual([r.input.question, r.input.earlierTurns], [q, []], "accounting is given the question alone");
    assert.equal(r.sql, null);
    assert.equal(r.rows.length, 0);
    assert.equal(r.explanation, selectNoSqlRefusal(q, "shr").explanation);
    assert.match(r.explanation, /population denominators/);
    assert.match(r.explanation, /covers homicide only/);
  });

  await check("GC-078: the violent/property/both clarification, zero rows, no instruction text", async () => {
    const r = await ask("Trends in crime in Mesa, Arizona, since 2017");
    noInstructionText(r);
    noInstructionInInput(r);
    assert.deepEqual(r.input.earlierTurns, [], "no earlier turns: the place instruction is not one");
    assert.equal(r.rows.length, 0);
    assert.match(r.explanation, /violent crime, property crime, or both/i, r.explanation);
  });

  await check("GC-106: the overdose limitation; no SQL, rows, number or Narcotics/Drugs statement", async () => {
    preparedSql.length = 0;
    const r = await ask("Number of overdose deaths in NJ since 1990");
    assert.equal(r.sql, null);
    assert.equal(r.rows.length, 0);
    assert.equal(r.explanation, SHR_OVERDOSE_NOT_RECORDED);
    assert.ok(!preparedSql.some((s) => /Narcotics\/Drugs/.test(s)), "no drug-weapon statement was prepared");
  });

  await check("drug overdoses in Ohio: the overdose limitation is delivered; no SQL, rows or drug-weapon statement", async () => {
    preparedSql.length = 0;
    const r = await ask("drug overdoses in Ohio");
    assert.equal(r.sql, null);
    assert.equal(r.rows.length, 0);
    assert.equal(r.explanation, SHR_OVERDOSE_NOT_RECORDED);
    assert.ok(!preparedSql.some((s) => /Narcotics\/Drugs/.test(s)));
  });

  await check("drug overdose death rate by race in Ohio: the overdose limitation is NOT replaced by the demographic-rate text", async () => {
    const r = await ask("drug overdose death rate by race in Ohio");
    assert.equal(r.sql, null);
    assert.equal(r.rows.length, 0);
    assert.equal(r.explanation, SHR_OVERDOSE_NOT_RECORDED, r.explanation);
    assert.doesNotMatch(r.explanation, /raw demographic counts|NIBRS question/);
  });

  await check("no-transform branch with a real earlier question: accounting is given that question and nothing else", async () => {
    const r = await ask("Trends in crime in Mesa, Arizona, since 2017", [
      { role: "user", content: "firearm murders in Chicago in 2020" },
      { role: "assistant", content: "There were 12 firearm murders in Chicago in 2020." },
    ]);
    noInstructionText(r);
    noInstructionInInput(r);
    bodyUnchanged(r);
    assert.equal(r.input.question, "Trends in crime in Mesa, Arizona, since 2017");
    assert.deepEqual(r.input.earlierTurns, ["firearm murders in Chicago in 2020"], "exactly the user's own earlier turn");
    assert.match(r.explanation, /violent crime, property crime, or both/i, r.explanation);
  });

  await check("transform branch (\"what about <place>?\" after an answer with SQL): accounting is given the reconstructed question, no earlier turns, no instruction", async () => {
    const r = await ask("what about Mesa, Arizona?", [
      { role: "user", content: "firearm murders in Chicago in 2020" },
      { role: "assistant", content: "There were 12 firearm murders in Chicago in 2020.\nSQL: SELECT COUNT(*) FROM incidents WHERE weapon_group = 'Firearm'" },
    ]);
    console.log(`        transform input: ${JSON.stringify(r.input)}`);
    noInstructionText(r);
    noInstructionInInput(r);
    bodyUnchanged(r);
    assert.notEqual(r.input.question, "what about Mesa, Arizona?", "the follow-up is accounted as reconstructed");
    assert.match(r.input.question, /firearm murders in Mesa, Arizona in 2020/i, r.input.question);
    assert.deepEqual(r.input.earlierTurns, [], "a reconstructed question carries its context itself");
  });

  await check("no-transform fragment follow-up: accounting is given the user's own earlier turn, not the instruction", async () => {
    const r = await ask("what about 2021?", [
      { role: "user", content: "firearm murders in Chicago in 2020" },
      { role: "assistant", content: "There were 12 firearm murders in Chicago in 2020." },
    ]);
    noInstructionText(r);
    noInstructionInInput(r);
    bodyUnchanged(r);
    assert.deepEqual([r.input.question, r.input.earlierTurns], ["what about 2021?", ["firearm murders in Chicago in 2020"]]);
  });

  await check("a real earlier restriction is still carried into a follow-up (firearm)", async () => {
    preparedSql.length = 0;
    const r = await ask("what about 2021?", [
      { role: "user", content: "firearm murders in Chicago in 2020" },
      { role: "assistant", content: "There were 12 firearm murders in Chicago in 2020." },
    ]);
    console.log(`        follow-up: sql=${String(r.sql).slice(0, 200)} | ${r.explanation.slice(0, 200)}`);
    const carried = /Firearm/.test(String(r.sql ?? "")) && /2021/.test(String(r.sql ?? ""));
    assert.ok(carried, `firearm carried: sql=${r.sql} explanation=${r.explanation.slice(0, 200)}`);
  });

  await check("source guard: shr-query and query build promptHistory as a new array (never `history` itself)", () => {
    for (const f of ["app/api/shr-query/route.ts", "app/api/query/route.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      const decl = src.match(/const promptHistory = followupTransform\s*\?[^;]*;/);
      assert.ok(decl, `${f}: promptHistory declaration found`);
      assert.doesNotMatch(decl![0], /:\s*history\s*;$/, `${f}: promptHistory aliases history`);
      assert.match(decl![0], /:\s*\[\.\.\.history\]\s*;$/, `${f}: the no-transform branch copies history`);
    }
  });

  await check("offline: no network call other than the stubbed model", () => assert.deepEqual(networkCalls, []));
  console.log(`  (stubbed model calls: ${modelCalls})`);
}

main()
  .catch((e) => { console.log(`  FAIL  suite crashed: ${(e as Error).stack}`); failed++; process.exitCode = 1; })
  .finally(() => {
    console.log(`\nshr guidance isolation (route): ${passed} passed, ${failed} failed`);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows keeps the handles open; harmless */ }
    process.exit(failed ? 1 : 0);
  });
