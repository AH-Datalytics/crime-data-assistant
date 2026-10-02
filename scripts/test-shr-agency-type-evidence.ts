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
import { validateDeterministicShrPlanSql, validateModelAuthoredShrSql } from "../lib/shr-authority";
import { yearClassAvailability, unresolvedInScope, unresolvedInScopes, unresolvedDisclosure, unresolvedLimitation, YEAR_CLASS_UNAVAILABLE_TEXT } from "../lib/shr-agency-year-class";
import { requestedAgencyCategories } from "../lib/shr-agency-type-authority";
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

console.log("\n7 - the agency/year classification: one authority for City/County membership (Codex combined ruling, 2026-10-02)");
{
  // Disposable files. Legacy incidents.agency_type values are set to MISLEAD: the county sheriff carries 'City', and
  // every 2026 row is blank -- as production's 2026 rows are. The relation must ignore them entirely.
  const shrPath = path.join(WORK, "class-shr.db"), nibrsPath = path.join(WORK, "class-nibrs.db");
  const shr = new Database(shrPath), nibrs = new Database(nibrsPath);
  shr.exec(fs.readFileSync(path.join(REPO, "scripts/fixtures/operation-taxonomy/shr.ddl.sql"), "utf8"));
  nibrs.exec(fs.readFileSync(path.join(REPO, "scripts/fixtures/operation-taxonomy/nibrs.ddl.sql"), "utf8"));
  const inc = shr.prepare("INSERT INTO incidents (year, month, state, ori, agency, population, homicide_type, agency_type) VALUES (?, 1, ?, ?, ?, ?, 'Murder', ?)");
  const vic = shr.prepare("INSERT INTO victims (incident_id, victim_num) VALUES (?, ?)");
  const add = (year: number, state: string, ori: string, agency: string, pop: number, legacy: string | null, victims: number) => {
    const id = inc.run(year, state, ori, agency, pop, legacy).lastInsertRowid;
    for (let k = 1; k <= victims; k++) vic.run(id, k);
  };
  // St. Louis city (City in NIBRS 2021-2025; 2026 carried forward) and the same-NAMED county sheriff (County).
  for (const y of [2024, 2025]) add(y, "MO", "MOSPD00", "St. Louis", 280000, "City", 3);
  add(2026, "MO", "MOSPD00", "St. Louis", 280000, "", 4);
  for (const y of [2024, 2026]) add(y, "MO", "MOSLC00", "St. Louis", 990000, y === 2026 ? "" : "City", 2);
  // Jackson: two NIBRS agencies share the 7-character identifier -> unresolved, never guessed.
  add(2026, "MS", "MS02501", "Jackson", 150000, "", 5);
  // Washington: no NIBRS match at all -> unresolved.
  add(2026, "DC", "DCMPD00", "Washington", 690000, "", 6);
  // An agency typed only from 2025: 2024 must stay unresolved (no later evidence decides an earlier year).
  for (const y of [2024, 2025]) add(y, "TX", "TXA0100", "Alamo", 300000, "City", 1);
  for (const y of [2021, 2022, 2023, 2024, 2025]) nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES ('MOSPD0000', ?, 'MO', 'St. Louis', 'City')").run(y);
  for (const y of [2023, 2024, 2025]) nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES ('MOSLC0000', ?, 'MO', 'St. Louis County', 'County')").run(y);
  nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES ('MS0250100', 2025, 'MS', 'Jackson', 'City')").run();
  nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES ('MS0250101', 2025, 'MS', 'Jackson County SO', 'County')").run();
  nibrs.prepare("INSERT INTO agencies (ori, year, state, city, agency_type) VALUES ('TXA010000', 2025, 'TX', 'Alamo', 'City')").run();
  shr.close(); nibrs.close();
  const f = { shrPath, nibrsPath, shr: new Database(shrPath), nibrs: new Database(nibrsPath) } as Fixture;
  const legacyBefore = JSON.stringify(f.shr.prepare("SELECT id, agency_type FROM incidents ORDER BY id").all());
  f.shr.close(); f.nibrs.close();
  const summary = build({ ...f, shr: undefined as never, nibrs: undefined as never });
  const db = new Database(shrPath);
  const cls = (ori: string, state: string, year: number) => db.prepare("SELECT membership, agency_type, reason, basis FROM shr_agency_year_class WHERE ori = ? AND state = ? AND year = ?").get(ori, state, year) as
    { membership: string; agency_type: string | null; reason: string | null; basis: string | null } | undefined;

  check(summary.classification && summary.classification.agencyYears === 9 && summary.classification.eligible === 4 && summary.classification.ineligible === 2 && summary.classification.unresolved === 3,
    `the builder materializes one row per agency-year: 9 = 4 City, 2 another type, 3 unresolved (${JSON.stringify(summary.classification)})`);
  const all = db.prepare("SELECT ori, state, year, membership, agency_type, reason FROM shr_agency_year_class ORDER BY ori, state, year").all() as
    { ori: string; state: string; year: number; membership: string; agency_type: string | null; reason: string | null }[];
  check(all.every((r) => { const e = loadShrTypeEvidence(db, r.year); const c = classifyShrAgency(e.byAgency.get(`${r.ori}|${r.state}`) ?? null, e.built, r.year);
    return c.membership === r.membership && (c.membership === "unresolved" ? c.reason === r.reason && r.agency_type === null : c.agencyType === r.agency_type); }),
    "every materialized row equals the existing classifier's decision for that agency and year -- not a second algorithm");
  const stl26 = cls("MOSPD00", "MO", 2026);
  check(stl26?.membership === "eligible" && stl26.agency_type === "City" && JSON.parse(stl26.basis!).carriedForwardFrom === 2025,
    "St. Louis city 2026: City, carried forward from 2025 with its basis recorded");
  check(cls("MOSLC00", "MO", 2026)?.membership === "ineligible" && cls("MOSLC00", "MO", 2026)?.agency_type === "County",
    "the same-named county sheriff: 'ineligible' with its exact type County (the legacy 'City' label is ignored)");
  check(cls("MS02501", "MS", 2026)?.reason === "several-nibrs-matches" && cls("MS02501", "MS", 2026)?.agency_type === null,
    "conflicting evidence (two NIBRS agencies): unresolved, with NULL type so no type filter can admit it");
  check(cls("DCMPD00", "DC", 2026)?.reason === "no-nibrs-match", "no NIBRS match: unresolved");
  check(cls("TXA0100", "TX", 2024)?.membership === "unresolved" && cls("TXA0100", "TX", 2025)?.membership === "eligible",
    "an agency first typed in 2025 stays unresolved for 2024: later evidence never decides an earlier year");
  check(JSON.stringify(db.prepare("SELECT id, agency_type FROM incidents ORDER BY id").all()) === legacyBefore,
    "incidents.agency_type is untouched: the derived result is never written into the source column");
  check((db.prepare("SELECT agency_years FROM shr_agency_year_class_meta").get() as { agency_years: number }).agency_years === 9, "a generation record states what was built");

  const avail = yearClassAvailability(db);
  check(avail.available, "built and current: available");
  // Delivered answers on the fixture.
  const J = "JOIN shr_agency_year_class c ON c.ori = i.ori AND c.state = i.state AND c.year = i.year";
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const classified = n(`SELECT COUNT(v.id) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.state = 'MO' AND i.year = 2026 AND c.agency_type = 'City'`);
  const blankAsCity = n("SELECT COUNT(v.id) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026 AND (i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')");
  const strictLegacy = n("SELECT COUNT(v.id) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026 AND i.agency_type = 'City'");
  check(classified === 4 && blankAsCity === 6 && strictLegacy === 0,
    `MO city murder victims, 2026: classified 4 (St. Louis city only); the old blank-as-City rule gave 6 (sheriff counted), the strict legacy filter 0 (${classified}/${blankAsCity}/${strictLegacy})`);
  const multi = n(`SELECT COUNT(v.id) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.state = 'MO' AND i.year BETWEEN 2024 AND 2026 AND c.agency_type = 'City'`);
  check(multi === 3 + 3 + 4, `a multi-year class join counts each victim once: 10 for St. Louis city 2024-2026 (${multi})`);

  // The authority on statements (lib/shr-authority.ts + lib/shr-agency-type-authority.ts).
  const model = (sql: string, a: ReturnType<typeof yearClassAvailability> | null = avail) =>
    validateModelAuthoredShrSql({ question: "How many murders happened in cities in Missouri in 2026?", sql, yearClass: a });
  const ok = model(`SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.state = 'MO' AND i.year = 2026 AND i.homicide_type = 'Murder' AND c.agency_type = 'City'`);
  check(queryContractFailureMessage(ok) === null && JSON.stringify(ok.agencyTypeScopes) === JSON.stringify([{ years: [2026, 2026], states: ["MO"] }]),
    "the approved form passes and carries its own year/state scope for the disclosure");
  for (const [label, sql] of [
    ["incidents.agency_type", "SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026 AND (i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')"],
    ["alias agency_type", "SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE agency_type = 'City' AND state = 'MO')"],
    ["OR'd type test", `SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.year = 2026 AND (c.agency_type = 'City' OR c.agency_type IS NULL)`],
    ["decorative join", `SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.year = 2026`],
    ["ori-only join", "SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN shr_agency_year_class c ON c.ori = i.ori WHERE c.agency_type = 'City'"],
    ["outer join", `SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id LEFT ${J} WHERE c.agency_type = 'City'`],
    ["year-unbound subquery", "SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN (SELECT ori FROM shr_agency_year_class WHERE agency_type = 'City')"],
  ] as const) {
    const r = model(sql);
    check(r.retryIssues.some((x) => x.startsWith("shr-agency-type-authority:")) && r.enforced.includes("shr-agency-type-authority") && !r.agencyTypeScopes,
      `model SQL with ${label}: one retry with the instruction, no licensed scope`);
  }
  const untouched = validateModelAuthoredShrSql({ question: "How many murders happened in Missouri in 2026?", yearClass: avail,
    sql: "SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026" });
  check(!untouched.enforced.includes("shr-agency-type-authority") && untouched.retryIssues.length === 0, "a request that does not depend on City/County membership keeps its path untouched");

  // ---- SCA-1 (Codex SHR classification ruling): the REQUEST decides, on the rows the answer counts ----
  const CITY_Q = "How many murders happened in cities in Missouri in 2026?";
  const asked = (question: string, sql: string) => validateModelAuthoredShrSql({ question, sql, yearClass: avail });
  const SEND_BACK = (x: ReturnType<typeof asked>) => x.retryIssues.some((s) => s.startsWith("shr-agency-type-authority:")) && !x.agencyTypeScopes;
  const CLASSIFIED = `SELECT i.year, COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.state = 'MO' AND i.year = 2026 AND i.homicide_type = 'Murder' AND c.agency_type = 'City' GROUP BY i.year`;
  const PLAIN = "SELECT i.year, COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026 GROUP BY i.year";
  check(SEND_BACK(asked(CITY_Q, PLAIN)), "a city question answered with NO classification is sent back (the SQL's wording no longer decides)");
  check(SEND_BACK(asked(CITY_Q, `WITH classified AS (${CLASSIFIED}) ${PLAIN}`)), "a valid classification in an UNUSED CTE does not license an unclassified count");
  check(SEND_BACK(asked(CITY_Q, CLASSIFIED.replace("c.agency_type = 'City'", "c.membership = 'ineligible'"))), "'ineligible' is not City: the wrong category is sent back");
  check(SEND_BACK(asked(CITY_Q, CLASSIFIED.replace("'City'", "'County'"))), "County answering a city question is the wrong category");
  check(SEND_BACK(asked(CITY_Q, `SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.year = 2026 AND i.ori IN (SELECT c.ori FROM shr_agency_year_class c WHERE c.agency_type = 'City' AND c.year = 2026)`)),
    "a classification inside a filtering subquery does not license the counted rows");
  // Codex SCA correction ruling: the classification restricts j while the victims are counted from i.
  const SECOND = `SELECT i.year, COUNT(DISTINCT v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN incidents j ON j.year = i.year AND j.state = i.state JOIN shr_agency_year_class c ON c.ori = j.ori AND c.state = j.state AND c.year = j.year WHERE i.state = 'MO' AND i.year = 2026 AND i.homicide_type = 'Murder' AND c.agency_type = 'City' GROUP BY i.year`;
  check(SEND_BACK(asked(CITY_Q, SECOND)), "a classification on a SECOND incidents instance does not license the instance whose rows are counted");
  check(SEND_BACK(asked(CITY_Q, SECOND.replace("c.ori = j.ori AND c.state = j.state AND c.year = j.year", "c.ori = i.ori AND c.state = i.state AND c.year = i.year"))),
    "two incidents instances are sent back even when the classification is on the counted one (one instance per counting scope)");
  check(SEND_BACK(asked("How many murders happened in Missouri in 2026?", CLASSIFIED)), "a question that asks no city/county distinction may not be narrowed by agency type");
  check(SEND_BACK(asked("How many murders happened in Missouri in 2026?", `SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'MO' AND i.year = 2026 AND i.ori IN (SELECT c.ori FROM shr_agency_year_class c WHERE c.agency_type = 'City')`)),
    "nor narrowed through a year-unbound classification subquery");
  const usedCte = asked(CITY_Q, `WITH classified AS (${CLASSIFIED}) SELECT year, victims FROM classified`);
  check(queryContractFailureMessage(usedCte) === null && JSON.stringify(usedCte.agencyTypeScopes) === JSON.stringify([{ years: [2026, 2026], states: ["MO"] }]),
    "a classification in a CTE the answer actually reads is followed and licensed");
  const member = asked(CITY_Q, CLASSIFIED.replace("c.agency_type = 'City'", "c.membership = 'eligible'"));
  check(queryContractFailureMessage(member) === null, "membership = 'eligible' is the same set as City");
  const sheriffs = asked("How many murders were reported by sheriffs in Missouri in 2026?", CLASSIFIED.replace("'City'", "'County'"));
  check(queryContractFailureMessage(sheriffs) === null && SEND_BACK(asked("How many murders were reported by sheriffs in Missouri in 2026?", CLASSIFIED)),
    "a sheriff question takes County, and City answering it is sent back");
  check(requestedAgencyCategories("How many murders in Kansas City in 2025?").length === 0 && requestedAgencyCategories("murders in New York City").length === 0
    && JSON.stringify(requestedAgencyCategories("murders in big cities in Texas")) === '["City"]',
    "a place NAME (Kansas City, New York City) is not a request about cities; plural cities is");
  const detCity = validateDeterministicShrPlanSql({ question: "fatal shootings in Springfield in 2025", yearClass: avail,
    sql: `SELECT i.year, COUNT(*) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.agency = 'St. Louis' AND i.year = 2026 AND c.agency_type = 'City' GROUP BY i.year` });
  // The classification authority's own verdict on the fallback's shape (the other contract checks judge its place and year).
  check(!detCity.blockReasons.includes(YEAR_CLASS_UNAVAILABLE_TEXT) && !detCity.retryIssues.some((s) => s.startsWith("shr-agency-type-authority"))
    && JSON.stringify(detCity.agencyTypeScopes) === JSON.stringify([{ years: [2026, 2026], states: null }]),
    "the deterministic fallback carries its own City category on its counted rows, with its own scope");

  // ---- SCA-2: the disclosure covers every counting scope; unreadable scope forms are sent back ----
  const UNION_Q = "How many murders happened in cities in Mississippi and Missouri in 2026?";
  const union = asked(UNION_Q, `${CLASSIFIED.replace("'MO'", "'MS'")} UNION ALL ${CLASSIFIED}`);
  check(queryContractFailureMessage(union) === null && JSON.stringify(union.agencyTypeScopes) === JSON.stringify([{ years: [2026, 2026], states: ["MS"] }, { years: [2026, 2026], states: ["MO"] }]),
    "a UNION keeps BOTH arms' scopes (the last one no longer overwrites the first)");
  const unionUnresolved = unresolvedInScopes(db, union.agencyTypeScopes!);
  check(unionUnresolved.agencies === 1 && /1 agency with up to 1 incident record in MS in 2026 and MO in 2026 could not be classified/.test(unresolvedDisclosure(unionUnresolved, union.agencyTypeScopes!)),
    "the union disclosure keeps Mississippi's unclassified agency and names both scopes");
  check(unresolvedInScopes(db, [...union.agencyTypeScopes!].reverse()).agencies === 1,
    "the disclosure counts every scope, not only the first (Mississippi's agency is found with Missouri listed first)");
  check(SEND_BACK(asked(UNION_Q, CLASSIFIED.replace("i.state = 'MO'", "(i.state = 'MO' OR i.state = 'MS')"))),
    "an OR over states is sent back (use IN) rather than disclosing a wrong all-states count");
  const inList = asked(UNION_Q, CLASSIFIED.replace("i.state = 'MO'", "i.state IN ('MO', 'MS')"));
  check(queryContractFailureMessage(inList) === null && JSON.stringify(inList.agencyTypeScopes) === JSON.stringify([{ years: [2026, 2026], states: ["MO", "MS"] }]),
    "the same places as an IN list are read exactly");
  check(/carried forward/.test(unresolvedDisclosure(unionUnresolved, union.agencyTypeScopes!)) && /several possible matches, or missing or conflicting types/.test(unresolvedDisclosure(unionUnresolved, union.agencyTypeScopes!))
    && !/for that year\./.test(unresolvedDisclosure(unionUnresolved, union.agencyTypeScopes!)),
    "the wording states carry-forward and what 'could not be classified' covers (not only missing types)");
  const unavailable = model(`SELECT COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.year = 2026 AND c.agency_type = 'City'`,
    { available: false, reason: "stale", detail: "x" });
  check(unavailable.blockReasons.includes(YEAR_CLASS_UNAVAILABLE_TEXT), "a stale or missing classification is an owned limitation, never blank-as-City");
  const det = validateDeterministicShrPlanSql({ question: "q", sql: "SELECT COUNT(*) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE (i.agency_type = 'City' OR i.agency_type IS NULL) AND i.year = 2026", yearClass: avail });
  check(det.blockReasons.length > 0 && det.enforced.includes("shr-agency-type-authority"), "a deterministic plan that reads a legacy type is blocked, not retried");

  // Disclosure and the no-apparent-zero rule, within the statement's own scope.
  const msScope = { years: [2026, 2026] as [number, number], states: ["MS"] };
  const msUnresolved = unresolvedInScope(db, msScope);
  const msCities = n(`SELECT COUNT(v.id) AS n FROM incidents i JOIN victims v ON v.incident_id = i.id ${J} WHERE i.state = 'MS' AND i.year = 2026 AND c.agency_type = 'City'`);
  check(msUnresolved.agencies === 1 && msUnresolved.incidents === 1 && msCities === 0,
    "Mississippi 2026: no classified city, one unresolved agency -- the case that must not read as zero");
  check(/^I can't give a reliable figure/.test(unresolvedLimitation(msUnresolved, msScope)) && /1 agency with up to 1 incident record in MS in 2026/.test(unresolvedLimitation(msUnresolved, msScope))
    && !/\b0\b/.test(unresolvedLimitation(msUnresolved, msScope).replace(/2026/g, "")), "its limited answer names the unclassified agency and states no zero");
  const moUnresolved = unresolvedInScope(db, { years: [2024, 2026], states: ["MO", "TX"] });
  check(moUnresolved.agencies === 1 && moUnresolved.incidents === 1, "MO+TX 2024-2026: only Alamo's 2024 row is unclassified (one agency, one record)");
  check(/1 agency with up to 1 incident record in MO, TX in 2024-2026 could not be classified/.test(unresolvedDisclosure(moUnresolved, { years: [2024, 2026], states: ["MO", "TX"] })),
    "the disclosure states the excluded agencies within the statement's scope");

  // Staleness: an agency-year added after the build makes the relation stale, hence unavailable.
  db.prepare("INSERT INTO incidents (year, month, state, ori, agency, homicide_type) VALUES (2026, 2, 'MO', 'MONEW00', 'New', 'Murder')").run();
  const stale = yearClassAvailability(db);
  check(!stale.available && stale.reason === "stale", `a new agency-year without a rebuild: stale (${stale.available ? "available" : stale.detail})`);
  db.exec("DROP TABLE shr_agency_year_class");
  const gone = yearClassAvailability(db);
  check(!gone.available && gone.reason === "not-built", "no relation: not built");
  db.close();
}

try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort */ }
console.log(`\nSHR agency-type evidence: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
