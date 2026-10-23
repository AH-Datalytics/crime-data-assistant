/**
 * Option 3 batch 1 (audit/presentation-2026-10-20/OVER-REFUSAL-PLAN-r3.md; Codex r3 ACCEPT), handler level.
 *
 * The real Current/Historical, NIBRS and SHR POST handlers run on fixture databases seeded with small known data, the
 * model stubbed and counted (its SQL must never run: every model reply carries a probe statement that would be
 * visible if executed), the network refused. Table A asserts each supported answer's statement, rows and text against
 * values computed independently from the seeds; table B asserts the named limitation or clarification; the
 * preservation controls assert that nothing else changed.
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

const preparedSql: string[] = [];
{
  const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } }).prototype;
  const realPrepare = proto.prepare;
  proto.prepare = function patchedPrepare(this: unknown, sql: string) { preparedSql.push(sql); return realPrepare.call(this, sql); };
}

let modelCalls = 0;
const network: string[] = [];
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (!url.includes("api.anthropic.com")) { network.push(url); throw new Error(`network refused: ${url}`); }
  modelCalls += 1;
  // A VALID statement for the asking source, so an opened model-SQL gate would execute it (an invalid probe is rejected by
  // other validators and would make the never-runs check vacuous). Marker column: model_sql_probe.
  let probeSql = "SELECT year, SUM(offense_count) AS model_sql_probe FROM summary_offense_location WHERE state = 'TX' AND ucr_offense_code = '220' AND year = 2025 GROUP BY year";
  try { const sys = JSON.stringify(JSON.parse(String((init as { body?: string })?.body ?? "{}")).system ?? ""); if (/historical U.S. crime database/i.test(sys)) probeSql = "SELECT year, murder_rate AS model_sql_probe FROM historical_state_national WHERE state = 'United States' ORDER BY year"; } catch { /* keep the NIBRS probe */ }
  return new Response(JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: JSON.stringify({ sql: probeSql, explanation: "STUB-MODEL-TEXT", title: "", chartHint: "none", xAxis: "", yAxis: "" }) }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof globalThis.fetch;

// ── Fixtures: the operation-taxonomy schemas plus small known seeds ─────────────────────────────────────────────────
const DDL = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "over-refusal-b1-"));
const open = (name: string, ddl: string) => { const db = new Database(path.join(DIR, name)); db.pragma("journal_mode = WAL"); db.exec(fs.readFileSync(path.join(DDL, ddl), "utf8")); return db; };

// NIBRS. Texas: two agencies; Mississippi: one; plus Ohio for a second state.
export const SEED = {
  // burglary (220) offenses by location type, Texas: convenience store (07) vs residence (20)
  txBurglaryConvenience: { 2024: 300, 2025: 310 }, txBurglaryResidence: { 2024: 9000, 2025: 8800 },
  // robbery (120) offenses and clearances by method, national (TX + OH), by year (all months summed)
  robbery: { 2022: [1000, 200, 50], 2023: [1100, 210, 40], 2024: [1200, 230, 60], 2025: [900, 180, 30] } as Record<number, [number, number, number]>,
};
{
  const db = open("nibrs.db", "nibrs.ddl.sql");
  const ag = db.prepare("INSERT INTO agencies (ori, year, state_code, state, city, population, agency_type) VALUES (?,?,?,?,?,?,?)");
  for (let y = 2020; y <= 2025; y += 1) {
    ag.run("TXHPD0000", y, "TX", "TX", "Houston", 2300000, "City");
    ag.run("TXDPD0000", y, "TX", "TX", "Dallas", 1300000, "City");
    ag.run("MSJPD0000", y, "MS", "MS", "Jackson", 150000, "City");
    ag.run("OHCPD0000", y, "OH", "OH", "Columbus", 900000, "City");
  }
  // every seeded agency reported all 12 months of every seeded year (the cohort the answers describe)
  const comp = db.prepare("INSERT INTO nibrs_agency_completeness (ori, year, months_reported, total_offenses) VALUES (?,?,?,?)");
  for (let y = 2020; y <= 2025; y += 1) for (const ori of ["TXHPD0000", "TXDPD0000", "MSJPD0000", "OHCPD0000"]) comp.run(ori, y, 12, 1000);
  db.exec("CREATE TABLE IF NOT EXISTS summary_offense_location (year INT, state TEXT, ori TEXT, ucr_offense_code TEXT, location_type TEXT, offense_count INT)");
  const ol = db.prepare("INSERT INTO summary_offense_location (year, state, ori, ucr_offense_code, location_type, offense_count) VALUES (?,?,?,?,?,?)");
  for (const y of [2024, 2025] as const) {
    ol.run(y, "TX", "TXHPD0000", "220", "07", SEED.txBurglaryConvenience[y] - 100); ol.run(y, "TX", "TXDPD0000", "220", "07", 100);
    ol.run(y, "TX", "TXHPD0000", "220", "20", SEED.txBurglaryResidence[y]);
    ol.run(y, "OH", "OHCPD0000", "220", "07", 777);
  }
  // offenders in violent offenses, Mississippi 2025, by weapon category and age group. Firearm rows: 13A 18-24 40, 13A 25-34 25,
  // 120 18-24 10, 09A 25-34 5. Excluded: a knife row, a non-violent (23H) firearm row, and Texas firearm rows.
  const od = db.prepare("INSERT INTO summary_offender_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, offender_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const [code, w, age, n, st, ori] of [["13A", "Firearm", "18-24", 40, "MS", "MSJPD0000"], ["13A", "Firearm", "25-34", 25, "MS", "MSJPD0000"], ["120", "Firearm", "18-24", 10, "MS", "MSJPD0000"], ["09A", "Firearm", "25-34", 5, "MS", "MSJPD0000"], ["13A", "Knife/Cutting Instrument", "18-24", 99, "MS", "MSJPD0000"], ["23H", "Firearm", "18-24", 77, "MS", "MSJPD0000"], ["13A", "Firearm", "18-24", 500, "TX", "TXHPD0000"]] as const) od.run(ori, 2025, code, w, "B", "M", age, "N", n, st);
  // THE U159 WITNESS FIXTURE: aggravated-assault (13A) victims in Texas, 2022-2024, where each agency-year has BOTH firearm and
  // non-firearm victims. Per victim, firearm = Houston 30 (12 handgun) + Dallas 20 (11 firearm) = 50 a year. The agency-year
  // EXISTS shape that failed live would instead count every 13A victim of both agencies (100 + 100 = 200 a year).
  db.exec("CREATE TABLE IF NOT EXISTS summary_victim_weapon (year INT, state TEXT, ori TEXT, ucr_offense_code TEXT, weapon_type TEXT, victim_count INT)");
  const vw = db.prepare("INSERT INTO summary_victim_weapon (year, state, ori, ucr_offense_code, weapon_type, victim_count) VALUES (?,?,?,?,?,?)");
  const vm = db.prepare("INSERT INTO summary_victim_city_monthly (year, month, state, ori, ucr_offense_code, victim_count) VALUES (?,?,?,?,?,?)");
  const vd13 = db.prepare("INSERT INTO summary_victim_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, victim_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let y = 2022; y <= 2024; y += 1) {
    // Overlap (codex build ruling item 1): 5 Houston victims had a handgun AND a rifle, so summary_victim_weapon also holds a rifle
    // (13) row of 5 for them; summing firearm types there would give 30 + 5 + 20 = 55, counting those 5 victims twice.
    for (const [ori, w, n] of [["TXHPD0000", "12", 30], ["TXHPD0000", "13", 5], ["TXHPD0000", "20", 70], ["TXDPD0000", "11", 20], ["TXDPD0000", "40", 80]] as const) vw.run(y, "TX", ori, "13A", w, n);
    // The count-once source (owner decision A): one row per victim, first-listed weapon category. Firearm 30 + 20 = 50.
    for (const [ori, cat, n] of [["TXHPD0000", "Firearm", 30], ["TXHPD0000", "Knife/Cutting Instrument", 70], ["TXDPD0000", "Firearm", 20], ["TXDPD0000", "Personal Weapons", 80]] as const) vd13.run(ori, y, "13A", cat, "B", "M", "25-34", "N", n, "TX");
    for (const ori of ["TXHPD0000", "TXDPD0000"]) vm.run(y, 1, "TX", ori, "13A", 100);
  }
  const ct = db.prepare("INSERT INTO summary_clearance_type (year, month, state, ori, ucr_offense_code, total_offenses, cleared_by_arrest, cleared_exceptional) VALUES (?,?,?,?,?,?,?,?)");
  for (const [y, [tot, arr, exc]] of Object.entries(SEED.robbery)) {
    // split each year's totals over two agencies in two states and two months, exactly
    ct.run(Number(y), 1, "TX", "TXHPD0000", "120", tot / 2, arr / 2, exc / 2);
    ct.run(Number(y), 6, "OH", "OHCPD0000", "120", tot / 2, arr / 2, exc / 2);
  }
  db.close();
}
{
  const db = open("crime_data.db", "crime_data.ddl.sql");
  const h = db.prepare("INSERT INTO historical_state_national (state, year, population, murder, murder_rate) VALUES (?,?,?,?,?)");
  // Current Trends: Cook County, IL (a county agency) and Austin, TX, 2024-2025, monthly; violent = murder+rape+robbery+agg assault.
  db.prepare("INSERT INTO agencies (ori, agency, state, type, total_months, national_sample) VALUES (?,?,?,?,?,?)").run("IL0160000", "Cook County", "IL", "County", 24, 0);
  const am = db.prepare("INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)");
  const apop = db.prepare("INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)");
  for (const y of [2024, 2025]) { apop.run("IL0160000", y, 100000); for (let m = 1; m <= 12; m += 1) for (const [off, n] of [["Murder", 1], ["Rape", 2], ["Robbery", y === 2024 ? 5 : 4], ["Aggravated Assault", y === 2024 ? 12 : 10], ["Burglary", 30]] as const) am.run("IL0160000", "Cook County", "IL", "County", y, m, off, n); }
  // Granbury, TX: violent crimes and population 2020-2024 (rate per 100k = violent / population * 100000)
  db.prepare("INSERT INTO historical_agency (ori, agency, state, type) VALUES (?,?,?,?)").run("TX1110100", "Granbury", "TX", "City");
  const hac = db.prepare("INSERT INTO historical_agency_crime (ori, year, population, violent, murder) VALUES (?,?,?,?,?)");
  const hap = db.prepare("INSERT INTO historical_agency_population (ori, year, population) VALUES (?,?,?)");
  for (const [y, v] of [[2020, 40], [2021, 44], [2022, 50], [2023, 45], [2024, 60]] as const) { hac.run("TX1110100", y, 12000, v, 1); hap.run("TX1110100", y, 12000); }
  for (let y = 2015; y <= 2024; y += 1) h.run("United States", y, 330000000, 16000 + y, 4 + (y - 2015) * 0.37); // distinct yearly rates
  db.close();
}
for (const [name, ddl] of [["query_log.db", "query_log.ddl.sql"], ["nibrs_rollups.db", "rollup.ddl.sql"], ["shr.db", "shr.ddl.sql"], ["hate_crime.db", "hc.ddl.sql"]]) open(name, ddl).close();
process.env.RTCI_DB_PATH = path.join(DIR, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(DIR, "query_log.db");
process.env.NIBRS_DB_PATH = path.join(DIR, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(DIR, "nibrs_rollups.db");
process.env.SHR_DB_PATH = path.join(DIR, "shr.db");
process.env.HATE_CRIME_DB_PATH = path.join(DIR, "hate_crime.db");
process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
delete process.env.PROOF_MODE;

const token = () => { const ts = String(Date.now() - 5000); const sec = process.env.AUTH_PASSWORD || "nibrs-page-token-secret"; return Buffer.from(`${ts}:${createHmac("sha256", sec).update(ts).digest("hex").slice(0, 16)}`).toString("base64"); };
let ip = 0;
type Tab = "current" | "historical" | "nibrs" | "shr";
type Answer = { status: number; sql: string | null; rows: Record<string, unknown>[]; text: string; title: string; guardrails: string; loggedQuestion: string };

async function main() {
  const { NextRequest } = await import("next/server");
  const R = {
    query: (await import("../app/api/query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
    nibrs: (await import("../app/api/nibrs-query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
    shr: (await import("../app/api/shr-query/route")) as unknown as { POST: (r: unknown) => Promise<Response> },
  };
  const ask = async (tab: Tab, question: string, history: unknown[] = []): Promise<Answer> => {
    modelCalls = 0; preparedSql.length = 0; ip += 1;
    const logDb = new Database(process.env.QUERY_LOG_DB_PATH!, { readonly: true });
    const before = (logDb.prepare("SELECT COALESCE(MAX(id),0) AS m FROM query_log").get() as { m: number }).m; logDb.close();
    const url = tab === "nibrs" ? "/api/nibrs-query" : tab === "shr" ? "/api/shr-query" : "/api/query";
    const body = { question, history, sessionId: `b1-${ip}`, pageToken: token(), ...(tab === "historical" ? { mode: "historical" } : {}) };
    const route = tab === "nibrs" ? R.nibrs : tab === "shr" ? R.shr : R.query;
    const res = await route.POST(new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.6.${ip % 250}.1` }, body: JSON.stringify(body) }));
    const raw = await res.text();
    let a: Omit<Answer, "guardrails" | "loggedQuestion">;
    if (raw.trimStart().startsWith("{")) { const j = JSON.parse(raw); a = { status: res.status, sql: j.sql || null, rows: Array.isArray(j.rows) ? j.rows : [], text: String(j.explanation ?? j.error ?? ""), title: String(j.title ?? "") }; }
    else {
      const ev = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
      const r = [...ev].reverse().find((e) => e.type === "result") ?? {}; const x = [...ev].reverse().find((e) => e.type === "explanation"); const er = ev.find((e) => e.type === "error");
      a = { status: res.status, sql: r.sql || null, rows: Array.isArray(r.rows) ? r.rows : [], text: String(x?.text ?? r.explanation ?? er?.text ?? ""), title: String(r.title ?? "") };
    }
    const logDb2 = new Database(process.env.QUERY_LOG_DB_PATH!, { readonly: true });
    const log = logDb2.prepare("SELECT guardrails, question FROM query_log WHERE id > ? ORDER BY id DESC LIMIT 1").get(before) as { guardrails: string | null; question: string | null } | undefined; logDb2.close();
    return { ...a, guardrails: String(log?.guardrails ?? ""), loggedQuestion: String(log?.question ?? "") };
  };
  const show = (a: Answer) => `status=${a.status} model=${modelCalls} rows=${a.rows.length} sql=${String(a.sql).slice(0, 220)} | ${a.text.slice(0, 260)} | ${a.guardrails.slice(0, 140)}`;
  const noModelSql = (a: Answer) => {
    assert.ok(!preparedSql.some((s) => /model_sql_probe/.test(s)), "a model statement was prepared");
    assert.ok(!a.rows.some((r) => "model_sql_probe" in r), "model statement rows were delivered");
  };
  const DEBUG = process.env.B1_DEBUG === "1";

  console.log("\ntable A: supported answers");
  await check("P025 burglaries at convenience stores in Texas last year -> location 07, burglary, TX, 2025; expected 310", async () => {
    const a = await ask("nibrs", "How many burglaries happened at convenience stores in Texas last year?");
    if (DEBUG) console.log(`        ${show(a)}`);
    noModelSql(a);
    assert.match(String(a.sql), /summary_offense_location/, show(a));
    assert.match(String(a.sql), /location_type/, show(a));
    assert.match(String(a.sql), /'07'/, show(a));
    assert.match(String(a.sql), /'220'/, show(a));
    assert.match(String(a.sql), /'TX'/, show(a));
    assert.match(String(a.sql), /2025/, show(a));
    // Independently: Houston 210 + Dallas 100 at convenience stores in 2025 = 310; residence (8,800) and Ohio (777) excluded.
    assert.equal(a.rows.length, 1, show(a));
    assert.deepEqual([a.rows[0].period, a.rows[0].place, a.rows[0].measure, a.rows[0].unit, a.rows[0].filter, a.rows[0].value], [2025, "Texas", "burglary", "offenses", "location: convenience store", SEED.txBurglaryConvenience[2025]], JSON.stringify(a.rows[0]));
  });
  await check("P312 robbery cleared by arrest vs exception 2022-2025 -> method breakdown; shares of ALL robbery offenses", async () => {
    const a = await ask("nibrs", "What percent of robberies were cleared by arrest vs exception from 2022 to 2025?");
    if (DEBUG) console.log(`        ${show(a)}`);
    noModelSql(a);
    const tot = Object.values(SEED.robbery).reduce((s, [t]) => s + t, 0);
    const arr = Object.values(SEED.robbery).reduce((s, [, x]) => s + x, 0);
    const exc = Object.values(SEED.robbery).reduce((s, [, , x]) => s + x, 0);
    const byCat = Object.fromEntries(a.rows.map((r) => [String(r.category), r]));
    assert.equal(Number(byCat["Cleared by arrest"]?.count), arr, show(a));
    assert.equal(Number(byCat["Cleared by exceptional means"]?.count), exc, show(a));
    assert.equal(Number(byCat["Not cleared"]?.count), tot - arr - exc, show(a));
    assert.equal(Number(byCat["Cleared by arrest"]?.share), Math.round((arr / tot) * 1000) / 10, `share of all robbery offenses: ${JSON.stringify(byCat["Cleared by arrest"])}`);
  });
  await check("P352 annual murder rates for the entire US -> the Historical national murder-rate series", async () => {
    const a = await ask("historical", "Can i see annual murder rates for the entire US");
    if (DEBUG) console.log(`        ${show(a)}`);
    noModelSql(a);
    assert.match(String(a.sql), /historical_state_national/, show(a));
    assert.match(String(a.sql), /United States/, show(a));
    assert.equal(a.rows.length, 10, show(a));
    const want = Array.from({ length: 10 }, (_, i) => 2015 + i).map((y) => [y, Math.round((4 + (y - 2015) * 0.37) * 10) / 10]); // delivered to one decimal
    assert.deepEqual(a.rows.map((r) => [Number(r.year), Number(r.value)]), want, JSON.stringify(a.rows.slice(0, 3)));
    assert.ok(a.rows.every((r) => r.place === "United States" && r.measure === "murder" && r.statistic === "rate_per_100k"), JSON.stringify(a.rows[0]));
    assert.match(a.text, /Murder rate per 100,000 residents for United States/, a.text);
  });

  await check("P236 violent crimes involving a firearm in Mississippi in 2025 by offender age -> OFFENDERS by age, firearm rows only", async () => {
    const a = await ask("nibrs", "show me violent crimes involving use of a firearm committed in mississippi in 2025 by offender age");
    if (DEBUG) console.log("        " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    assert.match(String(a.sql), /summary_offender_demographics/, show(a));
    assert.match(String(a.sql), /weapon_category/, show(a));
    const byAge = Object.fromEntries(a.rows.map((r) => [String(r.category ?? r.age_group ?? r.label), Number(r.count ?? r.value)]));
    // Independently: 18-24 = 40 + 10 = 50; 25-34 = 25 + 5 = 30 (knife, 23H and Texas rows excluded).
    assert.equal(byAge["18-24"], 50, JSON.stringify(a.rows));
    assert.equal(byAge["25-34"], 30, JSON.stringify(a.rows));
    assert.match(JSON.stringify(a.rows) + a.text + a.title, /offender/i, "the unit is stated as offenders");
  });
  await check("P384 what's granbury's violent crime rate -> the Historical agency violent-crime rate", async () => {
    const a = await ask("historical", "what's granbury's violent crime rate");
    if (DEBUG) console.log("        " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    // Independently: violent / 12,000 * 100,000 for 2020-2024.
    const want = [[2020, 40], [2021, 44], [2022, 50], [2023, 45], [2024, 60]].map(([y, v]) => [y, Math.round((v / 12000) * 100000 * 10) / 10]);
    assert.deepEqual(a.rows.map((r) => [Number(r.year), Number(r.value)]), want, JSON.stringify(a.rows));
    assert.ok(a.rows.every((r) => r.place === "Granbury, TX" && r.statistic === "rate_per_100k" && r.measure === "violent"), JSON.stringify(a.rows[0]));
  });
  await check("P242 calculate the percent change in violent crime rates in Cook County, IL from 2024-2025 -> the Current change type", async () => {
    const a = await ask("current", "calculate the percent change in violent crime rates in Cook County, IL from 2024-2025");
    if (DEBUG) console.log("        " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    // Independently: 2024 violent = (1+2+5+12)*12 = 240 per 100,000 residents; 2025 = (1+2+4+10)*12 = 204; change -36 = -15%.
    const by = Object.fromEntries(a.rows.map((r) => [String(r.period) + "|" + String(r.statistic), Number(r.value)]));
    assert.deepEqual([by["2024|rate_per_100k"], by["2025|rate_per_100k"], by["2024 vs 2025|change"], by["2024 vs 2025|percent_change"]], [240, 204, -36, -15], JSON.stringify(a.rows));
    assert.match(a.guardrails, /current-question-type:change/, a.guardrails);
    assert.doesNotMatch(String(a.sql), /Burglary/, "property offenses are not in the violent measure");
    assert.match(a.text, /Cook County, IL here is the county agency's own Current Trends record and its reported population, not a total for every agency in the county\./, a.text);
  });
  await check("P134 Let's look at Nashville -> the opener is read; with no measure the existing text path answers (a residual, no model SQL)", async () => {
    const a = await ask("historical", "Let's look at Nashville");
    if (DEBUG) console.log("        " + show(a));
    noModelSql(a);
    assert.equal(a.rows.length, 0, show(a));
    assert.doesNotMatch(a.text, /couldn't interpret "Let's look at"/, "the opener is no longer refused");
  });
  await check("P159 proxy control: firearm aggravated assault victims in Texas by year -> each victim once (50): never the per-type double count (55) or the agency-year aggregate (200); basis stated", async () => {
    const a = await ask("nibrs", "firearm aggravated assault victims in Texas by year from 2022 to 2024");
    if (DEBUG) console.log("        " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    assert.doesNotMatch(String(a.sql), /\bEXISTS\b/i, "no agency-level existence test");
    // Owner decision A: the count-once demographics table, never the per-type weapon table (which would give 55 here).
    assert.match(String(a.sql), /summary_victim_demographics/, show(a));
    assert.match(String(a.sql), /weapon_category/, show(a));
    assert.doesNotMatch(String(a.sql), /summary_victim_weapon/, show(a));
    assert.match(a.text, /Firearm here means the victim's first-listed weapon was a firearm: each victim is counted once, and a victim whose firearm was listed only second or third isn't counted./, a.text);
    assert.deepEqual(a.rows.map((r) => [Number(r.period ?? r.year), Number(r.value ?? r.count)]), [[2022, 50], [2023, 50], [2024, 50]], JSON.stringify(a.rows));
    assert.ok(a.rows.every((r) => /firearm/i.test(String(r.filter))), "every row names the firearm condition");
  });

  // ── table B: the right limitation or clarification by name (no number; the model's SQL never runs) ──────────────
  console.log("\ntable B: named limitations and clarifications");
  const refused = (a: Answer) => { noModelSql(a); assert.equal(a.rows.length, 0, show(a)); assert.equal(a.sql, null, show(a)); };
  const B_CASES: [string, Tab, string, RegExp[]][] = [
    ["P159 shooting limitation + proxy offer, spelling stated", "nibrs", "shootiny victimizations", [/^Read "shootiny" as "shooting"\./, /NIBRS does not track shootings as a category/, /ask for "firearm aggravated assault victims"/]],
    ["P301 Current has no national rate; Historical pointer", "current", "Can I see national overall and violent crime rates monthly from 2016 to present", [/no national or state rate/, /Historical tab/]],
    ["P019 spelling stated; the alternate-scale limitation (the column layout read as layout)", "current", "Chico California -- 2005-2024. Violent and Property cirme totals an drates per 1,000. I want columns of Year, Population, Violent Crimes, Violent crimes rate per 100,000, property crimes, property crimes rate per 1000, total part 1 crimes, total rate per 1000.", [/^Read "cirme" as "crime"; "an drates" as "and rates"\./, /I can't apply "per 1,000": rates are given per 100,000 residents/]],
    ["P367 spelling stated; drug distribution is a named not-recorded measure", "nibrs", "Posession or distribution of narcotics arrests in 2025 in Avondale Az", [/^Read "Posession" as "possession"\./, /doesn't record drug distribution or sales as its own measure \(drug possession and drug offenses are counted\)/]],
    ["P139 spelling stated; the offense breakdown reaches the compiler's no-table limitation", "nibrs", "can you break down the denver violent crime in to different catagories", [/^Read "catagories" as "categories"\./, /NIBRS has no summary table that holds violent crime offenses/, /by offense/]],
    ["P217 spelling stated; the ranked share by reason is a named unsupported combination", "nibrs", "Show me the states wit the highest share of rapes that were cleared by exception in 2025 broken down by the type of exceptional clearance", [/^Read "wit" as "with"\./, /ranking of only part of an offense isn't built/]],
    ["P170 spelling stated; police killings are justifiable homicides (never a murder count filtered to them)", "shr", "ow many people were killed by law enforcement officers in 2025", [/^Read "ow" as "how"\./, /Killings by police or by private citizens are recorded in the Homicide Reports as justifiable homicides, not murders/]],
    ["P213 spelling stated; 'the crime data' asks violent, property or both", "historical", "Show me the crime data for Jersey Village, Texas in comparisson to similar agencies in Size in Harris County, Texas", [/^Read "comparisson" as "comparison"\./, /Did you mean violent crime, property crime, or both\?/]],
    ["P222 the offender-age offense share is a named unit limitation", "nibrs", "what percentage of offenses with an offender under age 18 that involve use of a firearm are the crimes of murder, robbery, and aggravated assault", [/count offenders rather than distinct incidents/]],
    ["P039 the count is read; 'ever recorded' asks which ranking", "historical", "Show me the highest 20 violent crime rates ever recorded", [/I can't rank "ever recorded" yet/, /each place's highest year/]],
    ["P064 the count is read; the Current change ranking is declined by name", "current", "10 cities with largest drops in murder from 2021 to 2025", [/couldn't build this one/]],
    ["P339 Current does not track location types; NIBRS pointer", "current", "how many property crime happened at hotels", [/doesn't track where offenses happened/, /NIBRS tab records location types/]],
    ["P182 a chart style alone asks what to chart", "shr", "show stacked columns", [/That's a chart style\. Tell me what to count/]],
    ["P240 documents are not held", "historical", "can i see flowcharts or strategy diagrams of the VCRR factsheet or the DOJ violent crime reduction roadmap", [/doesn't record documents, diagrams or policy material/]],
    ["P078 the demographic-rate limitation", "nibrs", "do black people commit more crimes proportion wise", [/needs population denominators by race, sex or age/]],
    ["P341 statements in interviews are not recorded", "nibrs", "In chesterfield mo how many gun cases claim in an interview to have unrestricted access to the gun", [/doesn't record what people said in interviews/]],
    ["P160 thefts are outside Homicide Reports", "shr", "Show me theft in Omaha rolling over 12 months", [/Homicide Reports cover homicides only/]],
    ["P305 a five-digit year asks which year", "historical", "San Diego, California murders since 20210", [/"since 20210" doesn't name a year I can use\. Which year did you mean\?/]],
    ["P041 'Yes. Annual rates since 2016': asks which offense, keeping annual rates since 2016", "current", "Yes. Annual rates since 2016", [/^Which offense do you want annual rates since 2016 for \(for example murder, violent crime or property crime\), and for which place\?$/]],
    ["P149 a difference with no subject is declined with how to ask", "nibrs", "Let's see difference between 2023 and 2025.", [/I compare one measure for one place between two named years/]],
  ];
  for (const [name, tab, q, res] of B_CASES) {
    await check(name, async () => {
      const a = await ask(tab, q);
      if (DEBUG) console.log("        " + show(a));
      refused(a);
      for (const re of res) assert.match(a.text, re, a.text);
      assert.doesNotMatch(a.text, /couldn't interpret/, "a named disposition, not an unread-word refusal: " + a.text);
      assert.doesNotMatch(a.text, /STUB-MODEL-TEXT|424242/, "no model text in a named limitation");
    });
  }
  await check("P202 offense-code list: the metadata answer lists exactly the application's property-crime codes and labels", async () => {
    const { NIBRS_UCR_PROPERTY_CODES, UCR_CODES } = await import("../lib/nibrs-codes");
    const a = await ask("nibrs", "list of property offense codes in nibrs");
    if (DEBUG) console.log("        " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    assert.equal(modelCalls, 0, "answered without the model");
    assert.deepEqual(a.rows.map((r) => [r.code, r.offense]), NIBRS_UCR_PROPERTY_CODES.map((c) => [c, UCR_CODES[c] ?? c]), JSON.stringify(a.rows));
    assert.match(a.text, /NIBRS offense codes this tool counts as property crime/, a.text);
  });
  await check("P203 where to find clearance data: the metadata answer names this tool's clearance sources and the FBI's Crime Data Explorer", async () => {
    const a = await ask("historical", "Where can I find more data on clearance rates");
    if (DEBUG) console.log("        " + show(a));
    noModelSql(a);
    assert.equal(modelCalls, 0, "answered without the model");
    assert.match(a.text, /Historical tab has clearance percentages/, a.text);
    assert.match(a.text, /NIBRS tab has clearances by method/, a.text);
    assert.match(a.text, /cde\.ucr\.cjis\.gov/, a.text);
  });
  await check("numeric neighbors are NOT informational: a code count, a codes list plus a count, a source question plus a count", async () => {
    const cases: [Tab, string][] = [
      ["nibrs", "How many offenses for offense code 23C in Texas in 2024?"],
      ["nibrs", "list of property offense codes in nibrs and count burglaries in Texas in 2024"],
      ["historical", "Where can I find more data on clearance rates, and show murder counts in Texas in 2024"],
    ];
    for (const [tab, q] of cases) {
      const a = await ask(tab, q);
      if (DEBUG) console.log("        NEIGHBOR " + show(a));
      noModelSql(a);
      assert.doesNotMatch(a.text, /NIBRS offense codes this tool counts|Crime Data Explorer/, "the informational answer must not answer a numeric request: " + a.text);
      assert.doesNotMatch(a.guardrails, /metadata-coverage-answer/, a.guardrails);
    }
  });
  await check("spelling: the log row keeps the user's own words and carries the tag", async () => {
    const a = await ask("nibrs", "shootiny victimizations");
    assert.equal(a.loggedQuestion, "shootiny victimizations", a.loggedQuestion);
    assert.match(a.guardrails, /spelling-corrected/, a.guardrails);
  });

  // ── preservation controls ─────────────────────────────────────────────────────────────────────────────────────
  console.log("\npreservation controls");
  await check("carried: overdose deaths and US-citizen filters refused by name on NIBRS, Historical and Current; per-100,000 rate wording not", async () => {
    for (const tab of ["nibrs", "historical", "current"] as Tab[]) {
      const o = await ask(tab, "Number of overdose deaths in NJ since 1990");
      refused(o); assert.match(o.text, /overdose deaths/, o.text); assert.doesNotMatch(o.text, /couldn't interpret/, o.text);
      const c = await ask(tab, "murders by US citizens in Texas in 2020");
      refused(c); assert.match(c.text, /immigration or citizenship status/, c.text);
    }
    const r = await ask("nibrs", "murders per 100,000 citizens in Texas in 2020");
    assert.doesNotMatch(r.text, /citizenship status/, r.text);
  });
  await check("'overall violent crime' is total violent crime (a qualifier), not the all-seven measure", async () => {
    const { accountCurrentRequest } = await import("../lib/current-request-accounting");
    const l = accountCurrentRequest("Is Philadelphia's overall violent crime dropping compared to the nation?");
    const measures = l.parts.filter((p) => p.concept === "measure").map((p) => p.value);
    assert.deepEqual(measures, ["violent_crime"], JSON.stringify(measures));
    const l2 = accountCurrentRequest("Can I see national overall and violent crime rates monthly from 2016 to present");
    assert.deepEqual(l2.parts.filter((p) => p.concept === "measure").map((p) => p.value).sort(), ["all7", "violent_crime"]);
  });
  await check("spelling corrections never touch places, numbers, codes or other words", async () => {
    const { correctSpelling } = await import("../lib/spelling-corrections");
    for (const q of ["murders in Owingsville, KY", "murders since 20210", "Witt County murders", "robberies with the police", "how many murders in Ow, Texas", "offense code 23C in 2024", "burglaries by category"]) {
      assert.equal(correctSpelling(q).text, q, q);
    }
    assert.equal(correctSpelling("ow many robberies wit the most victims").text, "how many robberies with the most victims");
  });
  await check("spelling: original-coordinate spans survive two length-changing corrections, through the question check", async () => {
    const { correctSpelling, originalSpan } = await import("../lib/spelling-corrections");
    const { accountNibrsRequest } = await import("../lib/nibrs-request-accounting");
    const original = "comparisson posession arrests in Texas in 2024";
    const { text, corrections } = correctSpelling(original);
    assert.equal(text, "comparison possession arrests in Texas in 2024");
    assert.deepEqual(corrections.map((c) => [c.from, original.slice(c.span[0], c.span[1]), c.to, text.slice(c.normalizedSpan[0], c.normalizedSpan[1])]), [["comparisson", "comparisson", "comparison", "comparison"], ["posession", "posession", "possession", "possession"]]);
    const ledger = accountNibrsRequest(text);
    for (const p of ledger.parts) {
      const [a, b] = originalSpan(p.span as [number, number], corrections);
      const back = original.slice(a, b);
      // every ledger part maps back to the user's own words: the same text, or the misspelling it corrected
      const corrected = corrections.find((c) => p.span[0] <= c.normalizedSpan[0] && c.normalizedSpan[1] <= p.span[1]);
      assert.ok(corrected ? back.includes(corrected.from) : back === p.text, JSON.stringify({ part: p.text, back }));
    }
    const texas = ledger.parts.find((p) => /Texas/.test(p.text));
    assert.ok(texas, "a Texas part");
    const [ta, tb] = originalSpan(texas!.span as [number, number], corrections);
    assert.equal(original.slice(ta, tb), texas!.text, "an unchanged part after two corrections maps to its own original words");
  });
  // ── Codex build ruling r2 item 1: decision A's basis on every firearm victim answer, not only the series ──────
  const FIRST_WEAPON = /Firearm here means the victim's first-listed weapon was a firearm: each victim is counted once, and a victim whose firearm was listed only second or third isn't counted\./;
  await check("decision A on a breakdown: firearm aggravated assault victims in Texas in 2024 by age -> count-once table, basis stated", async () => {
    const a = await ask("nibrs", "firearm aggravated assault victims in Texas in 2024 by age");
    if (DEBUG) console.log("        BREAKDOWN " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    assert.match(String(a.sql), /summary_victim_demographics/, show(a));
    assert.doesNotMatch(String(a.sql), /summary_victim_weapon/, show(a));
    assert.equal(a.rows.reduce((t, r) => t + Number(r.count ?? 0), 0), 50, JSON.stringify(a.rows));
    assert.match(a.text, FIRST_WEAPON, a.text);
    assert.doesNotMatch(a.text, /slightly/, "no unmeasured magnitude claim");
  });
  await check("decision A on a share: the share of aggravated assault victims in Texas in 2024 with a firearm -> basis stated", async () => {
    const a = await ask("nibrs", "what share of aggravated assault victims in Texas in 2024 involved a firearm");
    if (DEBUG) console.log("        SHARE " + show(a) + " ROWS " + JSON.stringify(a.rows));
    noModelSql(a);
    if (/summary_victim_demographics/.test(String(a.sql))) assert.match(a.text, FIRST_WEAPON, a.text);
    else assert.equal(a.rows.length, 0, "a firearm victim share is either from the count-once table with its basis, or not answered: " + show(a));
  });
  // ── Codex build ruling r2 item 5: the effective-request spelling witness (a follow-up the route rebuilds) ──────
  await check("spelling: a rebuilt follow-up keeps the user's own word behind the corrected one; inherited words carry no correction", async () => {
    const { correctSpelling, associateCorrections, originalWordFor } = await import("../lib/spelling-corrections");
    const { detectFollowupTransform } = await import("../lib/followup-transform");
    const { accountNibrsRequest } = await import("../lib/nibrs-request-accounting");
    const history = [
      { role: "user" as const, content: "burglaries in Texas in 2023" },
      { role: "assistant" as const, content: "There were 100 burglaries in Texas in 2023.\nSQL: SELECT SUM(offense_count) FROM summary_state_monthly WHERE state = 'TX' AND ucr_offense_code = '220' AND year = 2023" },
    ];
    const turn = "what about Ohio, comparisson?";
    const { text, corrections } = correctSpelling(turn);
    // The same resolver the NIBRS route uses for the effective (guardrail) question.
    const transform = detectFollowupTransform(text, history as never);
    const effective = String((transform as { contextQuestion?: string } | null)?.contextQuestion ?? "");
    assert.equal(effective, "burglaries in Ohio, comparison in 2023", effective);
    const assoc = associateCorrections(effective, corrections);
    assert.deepEqual(assoc.map((x) => [x.correction.from, effective.slice(x.effectiveSpan[0], x.effectiveSpan[1])]), [["comparisson", "comparison"]]);
    const ledger = accountNibrsRequest(effective);
    const byText = (re: RegExp) => ledger.parts.find((p) => re.test(p.text));
    for (const [re, want] of [[/burglar/i, null], [/2023/, null], [/Ohio/, null]] as [RegExp, string | null][]) {
      const p = byText(re); assert.ok(p, "part " + re); assert.equal(originalWordFor(p!.span as [number, number], assoc), want, p!.text);
    }
    const word = effective.indexOf("comparison");
    assert.equal(originalWordFor([word, word + "comparison".length], assoc), "comparisson", "the corrected word maps back to the user's own misspelling");
    // a repeated corrected word is left unassociated, never guessed
    assert.deepEqual(associateCorrections("comparison of comparison", corrections), []);
  });
  await check("an opener does not swallow an exclusion or a negation", async () => {
    const { accountHistoricalRequest } = await import("../lib/historical-request-accounting");
    for (const q of ["Let's look at murders in Texas excluding Houston in 2020", "calculate the murder rate in Texas not counting Houston in 2020"]) {
      const l = accountHistoricalRequest(q);
      const opener = l.parts.find((p) => p.concept === "opener");
      assert.ok(opener && !/excluding|not/i.test(opener.text), q + " -> " + opener?.text);
      assert.ok(l.parts.some((p) => /excluding|not counting/i.test(p.text)), "the exclusion is its own part: " + JSON.stringify(l.parts.map((p) => p.text)));
    }
  });
  await check("a ranking count is not a population cohort: 'the 20 most populous cities' is not read as a top-20 count", async () => {
    const { accountHistoricalRequest } = await import("../lib/historical-request-accounting");
    const l = accountHistoricalRequest("murder rates in the 20 most populous cities in 2020");
    assert.ok(!l.parts.some((p) => p.concept === "rank" && String(p.value) === "top:20"), JSON.stringify(l.parts.map((p) => [p.concept, p.value, p.text])));
  });
  await check("prosecution-declined clearance stays a clearance reason; convictions stay a court refusal", async () => {
    const { accountNibrsRequest } = await import("../lib/nibrs-request-accounting");
    const a = accountNibrsRequest("robberies cleared because prosecution was declined in Ohio in 2024");
    assert.ok(a.parts.some((p) => String(p.value) === "clearance:B"), JSON.stringify(a.parts.map((p) => [p.concept, p.value])));
    const b = accountNibrsRequest("robbery convictions in Ohio in 2024");
    assert.ok(b.parts.some((p) => p.concept === "court" && p.state === "not-recorded"));
  });
  await check("SHR: 'larceny' and 'motor vehicle theft' stay homicide circumstances (the theft limitation never fires on them)", async () => {
    const { accountShrRequest } = await import("../lib/shr-request-accounting");
    for (const q of ["murders during motor vehicle theft in Texas in 2020", "larceny murders in Texas in 2020", "murders during a theft in Texas in 2020"]) {
      const l = accountShrRequest(q);
      assert.ok(!l.parts.some((p) => p.concept === "other-offense"), q + " -> " + JSON.stringify(l.parts.map((p) => [p.concept, p.text])));
    }
  });
  await check("the location filter never fires on a bare 'at' or 'in': 'murders in Texas' has no location filter", async () => {
    const { accountNibrsRequest } = await import("../lib/nibrs-request-accounting");
    const l = accountNibrsRequest("murders at night in Texas in 2024");
    assert.ok(!l.parts.some((p) => String(p.value).startsWith("location:")), JSON.stringify(l.parts.map((p) => [p.concept, p.value])));
  });

  // P074, P333, P175 (codex build ruling item 3): the causal limitation is delivered beside whatever else declines the request.
  await check("P074, P333, P175: the causal limitation beside the combination, lookup or policy limitation (no model SQL, no number)", async () => {
    const CAUSAL = /I also can't say what causes crime or what it is correlated with: Historical records reported crimes, not their causes./;
    const want: [string, RegExp][] = [["What is the correlation between police staffing and violent crime rates?", /Staffing and crime figures can't be combined/], ["What factors correlate with higher property crimes in Montgomery County, MD since 2023?", /couldn't find a Historical county agency for Montgomery County, MD/], ["tell me about how marijuana legalization has affected crime?", /doesn't record policies, laws or legalization/]];
    for (const [q, re] of want) { const r = await ask("historical", q); if (DEBUG) console.log("        " + show(r)); refused(r); assert.match(r.text, re, r.text); assert.match(r.text, CAUSAL, r.text); assert.doesNotMatch(r.text, /couldn't interpret|violent crime, property crime, or both/, r.text); }
  });

  // The never-runs assertion is live: opening a single model-SQL gate is not caught by this suite because these paths discard
  // model SQL at more than one layer (recorded in BUILD.md); this self-test shows the assertion fails when a probe ran.
  await check("self-test: the never-runs assertion fails when the model probe was prepared or delivered", () => {
    preparedSql.length = 0; preparedSql.push("SELECT year, murder_rate AS model_sql_probe FROM historical_state_national");
    assert.throws(() => noModelSql({ status: 200, sql: null, rows: [], text: "", title: "", guardrails: "", loggedQuestion: "" }));
    preparedSql.length = 0;
    assert.throws(() => noModelSql({ status: 200, sql: null, rows: [{ year: 2020, model_sql_probe: 1 }], text: "", title: "", guardrails: "", loggedQuestion: "" }));
  });
  // Complete-turn fix (2026-10-23, COMPLETE-TURN-FINDING.md): the owner's case after an earlier question and a follow-up.
  await check("complete turn: LAPD after a follow-up is its own question; an unknown acronym is named, not called a follow-up", async () => {
    const h = (q: string) => [{ role: "user", content: q, source: "historical" }, { role: "assistant", content: "Figures.\n[SQL: SELECT year, murder FROM historical_agency WHERE agency = 'Chicago']", source: "historical" }];
    const history = [...h("Chicago murder clearance rate since 1990"), ...h("what about robbery")];
    const lapd = await ask("historical", "LAPD murder clearance rate since 1960", history);
    if (DEBUG) console.log("        " + show(lapd));
    assert.doesNotMatch(lapd.text, /builds on an earlier follow-up|couldn't interpret "LAPD"/, lapd.text);
    const xyz = await ask("historical", "XYZPD murder clearance rate since 1960", history);
    if (DEBUG) console.log("        " + show(xyz));
    refused(xyz);
    assert.match(xyz.text, /couldn't interpret "XYZPD"/, xyz.text);
    assert.doesNotMatch(xyz.text, /builds on an earlier follow-up/, xyz.text);
    // K2 control: a real fragment after a follow-up still gets the follow-up refusal.
    const frag = await ask("historical", "and since 1960?", history);
    refused(frag);
    assert.match(frag.text, /builds on an earlier follow-up|complete question/, frag.text);
  });
  await check("offline: no network call", () => assert.deepEqual(network, []));
}

main()
  .catch((e) => { console.log(`  FAIL  suite crashed: ${(e as Error).stack}`); failed++; process.exitCode = 1; })
  .finally(() => {
    console.log(`\nover-refusal batch 1 (route): ${passed} passed, ${failed} failed`);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows keeps handles open */ }
    process.exit(failed ? 1 : 0);
  });
