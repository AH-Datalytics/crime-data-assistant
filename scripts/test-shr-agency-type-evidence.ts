/**
 * The REAL SHR agency-type evidence builder (scripts/build-shr-agency-type-evidence.ts), run as its own process on
 * disposable SHR and NIBRS database FILES in a private temporary folder, then read through the actual classification
 * (lib/shr-agency-classification.ts), SHR ranking adapter and deterministic SQL validator.
 *
 * Holds Codex's classification-review witnesses (audit/phase3-shr-classification-2026-09-30/codex-witness.cjs) as
 * retained checks -- SC-1: another state's row, a later-only second match; SC-2: blank and carried-forward years --
 * with healthy and genuine-conflict counterparts. Not guarded by scripts/offline-evidence-guard.ts, because the builder
 * needs database files; nothing here reads a real database, contacts a server or installs anything.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { classifyShrAgency, loadShrTypeEvidence } from "../lib/shr-agency-classification";
import { planShrCityRanking, runShrCityRanking } from "../lib/city-ranking-shr";
import { validateDeterministicShrPlanSql } from "../lib/shr-authority";
import { queryContractFailureMessage } from "../lib/query-contract-validator";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}
const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "shr-type-evidence-"));
const reason = (x: ReturnType<typeof classifyShrAgency>) => (x.membership === "unresolved" ? x.reason : x.membership);

type Fixture = { shrPath: string; nibrsPath: string; shr: Database.Database; nibrs: Database.Database };
function setup(name: string, agencies: [string, string][]): Fixture {
  const shrPath = path.join(WORK, `${name}-shr.db`), nibrsPath = path.join(WORK, `${name}-nibrs.db`);
  const shr = new Database(shrPath), nibrs = new Database(nibrsPath);
  shr.exec(fs.readFileSync(path.join(REPO, "scripts/fixtures/operation-taxonomy/shr.ddl.sql"), "utf8"));
  nibrs.exec(fs.readFileSync(path.join(REPO, "scripts/fixtures/operation-taxonomy/nibrs.ddl.sql"), "utf8"));
  for (const [ori, label] of agencies) {
    const id = shr.prepare("INSERT INTO incidents (year, month, state, ori, agency, population, homicide_type) VALUES (2025, 1, 'IL', ?, ?, 200000, 'Murder')").run(ori, label).lastInsertRowid;
    for (let i = 1; i <= 4; i++) shr.prepare("INSERT INTO victims (incident_id, victim_num) VALUES (?, ?)").run(id, i);
  }
  return { shrPath, nibrsPath, shr, nibrs };
}
const nibrsRow = (f: Fixture, ori: string, year: number, state: string, type: string) =>
  f.nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES (?, ?, ?, 'fixture', ?)").run(ori, year, state, type);
function build(f: Fixture) {
  const r = spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/build-shr-agency-type-evidence.ts"), "--apply"],
    { cwd: REPO, windowsHide: true, encoding: "utf8", timeout: 60000, env: { ...process.env, SHR_DB_PATH: f.shrPath, NIBRS_DB_PATH: f.nibrsPath } });
  if (r.status !== 0) throw new Error(`builder failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n")[0]);
}
const classify = (f: Fixture, ori: string, year = 2025) => { const e = loadShrTypeEvidence(f.shr, year); return classifyShrAgency(e.byAgency.get(`${ori}|IL`) ?? null, e.built, year); };
const QUESTION = "What cities over 100k population had the highest homicide rates in 2025";
function rank(f: Fixture) {
  const plan = planShrCityRanking(QUESTION, { year: 2025, month: 12, observed: true });
  if (plan?.kind !== "deterministic") throw new Error("the 2025 ranking did not plan");
  return runShrCityRanking(plan, {
    typeEvidence: (y) => loadShrTypeEvidence(f.shr, y),
    validate: (sql) => { const c = validateDeterministicShrPlanSql({ sql, question: QUESTION }); return queryContractFailureMessage(c) ? null : { sql: c.sql, rows: () => f.shr.prepare(c.sql).all() as Record<string, unknown>[] }; },
  });
}
const oris = (out: ReturnType<typeof rank>) => (out.kind === "answer" ? out.rows.map((r) => String(r.ori)) : null);

console.log("\n1 - SC-1: another state's row is kept as that state's and rejected, never borrowed");
{
  // Codex witness 1: the only prefix match has a 2024 MO City row and a 2026 IL blank row.
  const f = setup("state", [["IL00001", "Wrong-state evidence"], ["IL00002", "Healthy control"]]);
  nibrsRow(f, "IL0000100", 2024, "MO", "City"); nibrsRow(f, "IL0000100", 2026, "IL", "");
  nibrsRow(f, "IL0000200", 2025, "IL", "City");
  build(f);
  const stored = f.shr.prepare("SELECT nibrs_ori, year, nibrs_state, agency_type FROM shr_agency_type_evidence WHERE ori = 'IL00001' ORDER BY year").all();
  check(JSON.stringify(stored) === JSON.stringify([{ nibrs_ori: "IL0000100", year: 2024, nibrs_state: "MO", agency_type: "City" }, { nibrs_ori: "IL0000100", year: 2026, nibrs_state: "IL", agency_type: "" }]),
    "the builder keeps each row's own state: the MO row is stored as MO, not relabeled IL");
  // Year-bound selection: the identifier's only same-state row is 2026, so for 2025 it is not a candidate at all --
  // its 2024 MO City row is neither borrowed nor allowed to decide anything.
  check(reason(classify(f, "IL00001")) === "no-nibrs-year", "another state's City row is never borrowed: with no same-state row through 2025 there is no candidate for 2025");
  const out = rank(f);
  check(JSON.stringify(oris(out)) === JSON.stringify(["IL00002"]) && out.kind === "answer" && !out.complete
    && /Wrong-state evidence, IL — no NIBRS agency matching its identifier has a year in its state up to the ranking year/.test(out.explanation),
    `the 2025 ranking delivers only the healthy same-state control, is partial, and says why the other is not classified: ${JSON.stringify(oris(out))}`);
  f.shr.close(); f.nibrs.close();
}
{
  // A SELECTED candidate (same-state row through Y) that also has another state's row through Y: refused, not hidden.
  const f = setup("selected-conflict", [["IL00011", "Mixed state"], ["IL00012", "Healthy control"]]);
  nibrsRow(f, "IL0001100", 2024, "MO", "City"); nibrsRow(f, "IL0001100", 2025, "IL", "City");
  nibrsRow(f, "IL0001200", 2025, "IL", "City");
  build(f);
  const out = rank(f);
  check(reason(classify(f, "IL00011")) === "state-conflict" && JSON.stringify(oris(out)) === '["IL00012"]'
    && out.kind === "answer" && /Mixed state, IL — its matching NIBRS agency is recorded under another state in those years/.test(out.explanation),
    `a selected candidate's other-state row through the year is still refused as a conflict: ${JSON.stringify(oris(out))}`);
  f.shr.close(); f.nibrs.close();
}

console.log("\n1b - SC-1 (Codex SHR ranking result witness): a future same-state row cannot remove an earlier city answer");
{
  // IL00001 has a valid 2025 IL City match. A second prefix identifier has only a 2024 WI City row (not a candidate).
  // Adding only a 2026 IL County row for it admits it to the build -- but must not change the 2025 answer.
  const f = setup("future-state", [["IL00001", "Valid city"], ["IL00002", "Healthy control"]]);
  nibrsRow(f, "IL0000100", 2025, "IL", "City");
  nibrsRow(f, "IL0000199", 2024, "WI", "City");
  nibrsRow(f, "IL0000200", 2025, "IL", "City");
  build(f);
  const before = rank(f), beforeCls = classify(f, "IL00001");
  nibrsRow(f, "IL0000199", 2026, "IL", "County");
  const summary = build(f);
  const after = rank(f), afterCls = classify(f, "IL00001");
  check(summary.otherStateRows === 1 && JSON.parse((f.shr.prepare("SELECT candidate_oris FROM shr_agency_type_binding WHERE ori = 'IL00001'").get() as { candidate_oris: string }).candidate_oris).join() === "IL0000100,IL0000199",
    "the rebuild does admit the second identifier and its old WI row (the premise of the witness)");
  check(beforeCls.membership === "eligible" && afterCls.membership === "eligible"
    && JSON.stringify(oris(before)) === '["IL00001","IL00002"]' && JSON.stringify(oris(after)) === '["IL00001","IL00002"]'
    && before.kind === "answer" && after.kind === "answer" && before.complete && after.complete,
    `the 2025 answer is unchanged by the future row: before ${JSON.stringify(oris(before))} ${reason(beforeCls)}, after ${JSON.stringify(oris(after))} ${reason(afterCls)}`);
  check(reason(classify(f, "IL00001", 2026)) === "state-conflict",
    "for 2026 the second identifier IS a candidate (IL row in 2026) and its WI row through 2026 is refused as a conflict");
  f.shr.close(); f.nibrs.close();
}

console.log("\n2 - SC-1: a match that appears only after the ranking year changes nothing about it");
{
  // Codex witness 2.
  const f = setup("future", [["IL00003", "Past city"]]);
  nibrsRow(f, "IL0000300", 2025, "IL", "City");
  build(f);
  const before = classify(f, "IL00003"), answerBefore = rank(f);
  nibrsRow(f, "IL0000301", 2026, "IL", "County");
  build(f);
  const after = classify(f, "IL00003"), answerAfter = rank(f);
  check(before.membership === "eligible" && after.membership === "eligible" && JSON.stringify(oris(answerBefore)) === '["IL00003"]' && JSON.stringify(oris(answerAfter)) === '["IL00003"]',
    `a later-only second match leaves the 2025 answer unchanged (before ${reason(before)}, after ${reason(after)})`);
  check(reason(classify(f, "IL00003", 2026)) === "several-nibrs-matches", "genuine contemporaneous ambiguity: for 2026 both matches exist, so it is unresolved");
  f.shr.close(); f.nibrs.close();
}

console.log("\n3 - SC-2: each agency's own basis, with blank years and carry-forward stated");
{
  // Codex witness 3: typed City only in 2023 with a blank 2025 row; another typed City only in 2025.
  const f = setup("wording", [["IL00004", "Earlier evidence"], ["IL00005", "Later evidence"]]);
  nibrsRow(f, "IL0000400", 2023, "IL", "City"); nibrsRow(f, "IL0000400", 2025, "IL", "");
  nibrsRow(f, "IL0000500", 2025, "IL", "City");
  build(f);
  const out = rank(f);
  check(out.kind === "answer" && JSON.stringify(oris(out)) === '["IL00004","IL00005"]', "both still rank (the approved carry-forward is kept)");
  check(out.kind === "answer" && /Earlier evidence, IL — City in 2023; no type in 2025; carried forward from 2023/.test(out.explanation)
    && /Later evidence, IL — City in 2025\./.test(out.explanation),
    "each agency's own basis -- typed year, blank year, carry-forward -- is stated, not a shared range");
  check(out.kind === "answer" && !/every year it reported|2023–2025|City in every year/.test(out.explanation)
    && /years with no type are not counted, and when the latest typed year is earlier, that City is carried forward/.test(out.explanation)
    && /this project's NIBRS pipeline derives one from the agency's population group/.test(out.explanation),
    "no claim of City in every reported year; the carry-forward rule and the NIBRS database's derivation are stated");
  f.shr.close(); f.nibrs.close();
}

console.log("\n4 - healthy and genuine-conflict counterparts");
{
  const f = setup("healthy", [["IL00006", "Steady city"], ["IL00007", "Changed type"], ["IL00008", "Twin prefix"]]);
  for (const y of [2023, 2024, 2025]) nibrsRow(f, "IL0000600", y, "IL", "City");
  nibrsRow(f, "IL0000700", 2024, "IL", "County"); nibrsRow(f, "IL0000700", 2025, "IL", "City");
  nibrsRow(f, "IL0000800", 2025, "IL", "City"); nibrsRow(f, "IL0000801", 2024, "IL", "County");
  nibrsRow(f, "IL0000699", 2025, "WI", "City");        // prefix of IL00006 but never in IL: another agency, not a candidate
  const summary = build(f);
  const out = rank(f);
  check(JSON.stringify(oris(out)) === '["IL00006"]' && reason(classify(f, "IL00007")) === "type-changed" && reason(classify(f, "IL00008")) === "several-nibrs-matches",
    `a steady same-state city ranks; a real type change and a real two-agency prefix are refused: ${JSON.stringify(oris(out))}`);
  const cands = f.shr.prepare("SELECT candidate_oris FROM shr_agency_type_binding WHERE ori = 'IL00006'").get() as { candidate_oris: string };
  check(summary.otherStateRows === 0 && JSON.parse(cands.candidate_oris).join() === "IL0000600", "a prefix ORI that is never in the SHR state is not a candidate at all");
  check(out.kind === "answer" && /Steady city, IL — City in 2023, 2024 and 2025\./.test(out.explanation), "its basis lists the typed years");
  f.shr.close(); f.nibrs.close();

  console.log("\n5 - SC-3: the recovery's outcome check runs the owned ranking read-only");
  const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const before = sha(f.shrPath);
  const r = spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/shr-ranking-check.ts"), QUESTION],
    { cwd: REPO, windowsHide: true, encoding: "utf8", timeout: 60000, env: { ...process.env, SHR_DB_PATH: f.shrPath } });
  const report = r.status === 0 ? JSON.parse(r.stdout) : null;
  check(!!report && report.kind === "answer" && report.confirmedRows === 1 && report.rows[0].ori === "IL00006" && report.complete === false
    && report.cutoff.year === 2025 && report.statements === 2 && /Changed type, IL — NIBRS recorded more than one type/.test(report.explanation),
    `the check reports the confirmed rows, partial disposition and the reasons, from the route's own cutoff: ${r.status} ${r.stderr.slice(0, 200)}`);
  check(sha(f.shrPath) === before, "and the SHR database is byte-identical afterwards (opened read-only)");
  const missing = spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/shr-ranking-check.ts")],
    { cwd: REPO, windowsHide: true, encoding: "utf8", timeout: 60000, env: { ...process.env, SHR_DB_PATH: path.join(WORK, "absent.db") } });
  check(missing.status !== 0 && !fs.existsSync(path.join(WORK, "absent.db")), "a missing database is an error, never created");
}

console.log("\n6 - a failure part-way through the write leaves the previous tables (one transaction)");
{
  const f = setup("rollback", [["IL00009", "First"], ["IL00010", "Second"]]);
  nibrsRow(f, "IL0000900", 2025, "IL", "City"); nibrsRow(f, "IL0001000", 2025, "IL", "City");
  build(f);
  const before = JSON.stringify(f.shr.prepare("SELECT * FROM shr_agency_type_evidence ORDER BY ori").all());
  // A NIBRS agencies table WITHOUT its primary key, holding one agency-year twice: the builder reads both rows and
  // its second evidence INSERT for that agency-year violates the evidence key -- after the tables were dropped and
  // recreated and the first agency's rows written. Only a transaction brings the previous tables back.
  f.nibrs.close();
  const broken = new Database(f.nibrsPath);
  broken.exec("DROP TABLE agencies; CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT);");
  for (const [ori, type] of [["IL0000900", "City"], ["IL0001000", "County"], ["IL0001000", "County"]]) broken.prepare("INSERT INTO agencies VALUES (?, 2025, 'IL', 'fixture', ?)").run(ori, type);
  broken.close();
  let failed = false;
  try { build(f); } catch { failed = true; }
  const after = JSON.stringify(f.shr.prepare("SELECT * FROM shr_agency_type_evidence ORDER BY ori").all());
  check(failed && after === before, `the build fails mid-write and the previous evidence is intact (${failed ? "failed" : "did not fail"})`);
  f.shr.close();
}

try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort */ }
console.log(`\nSHR agency-type evidence: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
