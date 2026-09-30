/**
 * Typed-outcome catalog, gate, carrier, migration and coverage — P2.1 §4.7 T1, T1b, T1c, T2, T3,
 * T4, T5, T6, T7e, T7f, T8, T9, T11.
 *
 * PRODUCTION IS NEVER TOUCHED. Every database case runs against a fresh temp-directory fixture.
 * Applying either migration to /opt/nibrs/shared/query_log.db is a separate approval.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  OUTCOME_CATALOG,
  OUTCOMES,
  OUTCOME_STORES,
  OUTCOME_OMISSION_SHARED_STRINGS,
  OMISSION_REASONS,
  DELIVERY_ACTIONS,
  PRODUCIBLE_DELIVERY_ACTIONS,
  REASON_CODES,
  admissiblePairs,
  isAdmissiblePair,
  type OmissionReason,
} from "../lib/proof-contract";
import {
  finalizeProof,
  outcomeLogFields,
  proofLogFields,
  decisionRecord,
  asOutcomeRecord,
  OPERATIONAL_RECORD,
  EMPTY_OUTCOME_LOG_FIELDS,
  type ProofFinalization,
} from "../lib/proof-finalize";
import { outcomeLoggingEnabled, outcomeWritesEnabled } from "../lib/proof-modes";
import { buildQueryLogInsert, QUERY_LOG_MIGRATED_COLUMNS } from "../lib/query-log-columns";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const queryLogMigration = require("./migrate-query-log-proof.js") as {
  migrate: (o: { dbPath: string; dryRun: boolean; rollback: boolean }) =>
    { changed: boolean; columnsChanged: string[]; indexChanged: boolean };
  COLUMNS: { name: string; type: string }[];
  INDEX_NAME: string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildInventory } = require("./lib/exit-inventory.js") as {
  buildInventory: (root: string) => {
    decisionSites: { outcome: { form: string; reason?: string; whenTrue?: string; whenFalse?: string } }[];
    embed: { sites: { outcome: { whenTrue?: string; whenFalse?: string } }[] };
  };
};

const ROOT = path.resolve(__dirname, "..");
const ON = { OUTCOME_LOG: "on" } as Record<string, string | undefined>;
const OFF = {} as Record<string, string | undefined>;

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ok  ${name}`); }

function tmpDb(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-cov-"));
  return { dir, file: path.join(dir, "query_log.db") };
}
function baselineQueryLog(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT,
    rows INTEGER, error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT,
    session_id TEXT, routing_confidence REAL, routing_mode TEXT, routing_reason TEXT,
    query_guidance TEXT, query_contract TEXT)`);
  return db;
}
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "current" as const,
    question: "how many murders in 2024",
    sql: "SELECT 1",
    rows: [{ n: 1 }],
    columns: ["n"],
    truncated: false,
    planFamily: null as string | null,
    outcome: OUTCOMES.deterministic_plan,
    env: OFF,
    ...overrides,
  };
}

console.log("outcome catalog, gate, carrier, migration and coverage");

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────
check("T1 the catalog is exhaustive over the producible actions", () => {
  // 24 P2.1 rows plus the four named at existing accepted Phase 3 branches on integration (Codex Gate A
  // vocabulary ruling, 2026-09-30): clarify measure_ambiguous and followup_ambiguous; decline_data
  // reporting_coverage_insufficient and annual_result_not_supported. Each is query_log only.
  assert.strictEqual(OUTCOME_CATALOG.length, 28, "24 P2.1 rows plus the 4 integration rows");
  assert.strictEqual(new Set(REASON_CODES).size, 28, "every reason appears exactly once");
  for (const action of PRODUCIBLE_DELIVERY_ACTIONS) {
    const n = OUTCOME_CATALOG.filter((e) => e.action === action).length;
    assert.ok(n >= 1, `${action} must have at least one reason`);
  }
  assert.deepStrictEqual(
    Object.fromEntries(PRODUCIBLE_DELIVERY_ACTIONS.map((a) =>
      [a, OUTCOME_CATALOG.filter((e) => e.action === a).length])),
    { answer: 3, clarify: 6, decline_data: 7, decline_capability: 11, decline_source_health: 1 });
});

check("T1 answer_limited_scope stays a DeliveryAction with no catalog row", () => {
  assert.ok(DELIVERY_ACTIONS.includes("answer_limited_scope"),
    "the persisted action vocabulary is six; the reserved member is not deleted");
  assert.strictEqual(
    OUTCOME_CATALOG.filter((e) => (e.action as string) === "answer_limited_scope").length, 0,
    "inventing a reason so an exhaustiveness assertion could pass would invent a product path");
  // The cast is deliberate: without it TypeScript rejects the comparison because the derived
  // element type already excludes the reserved action. That the compiler can prove it is the
  // stronger result; the runtime assertion is kept so the property is checked either way.
  assert.ok(!(PRODUCIBLE_DELIVERY_ACTIONS as readonly string[]).includes("answer_limited_scope"));
});

check("T1 every reason is used by at least one of the 97 finalization sites", () => {
  const inv = buildInventory(ROOT);
  const used = new Set<string>();
  for (const s of inv.decisionSites) {
    if (s.outcome.reason) used.add(s.outcome.reason);
    if (s.outcome.whenTrue) used.add(s.outcome.whenTrue);
    if (s.outcome.whenFalse) used.add(s.outcome.whenFalse);
  }
  for (const s of inv.embed.sites) {
    if (s.outcome.whenTrue) used.add(s.outcome.whenTrue);
    if (s.outcome.whenFalse) used.add(s.outcome.whenFalse);
  }
  const declaredButUnused = REASON_CODES.filter((r) => !used.has(r));
  assert.deepStrictEqual(declaredButUnused, [],
    "a declared-but-unused code is vocabulary nobody can produce");
  const usedButUndeclared = [...used].filter((r) => !(REASON_CODES as string[]).includes(r));
  assert.deepStrictEqual(usedButUndeclared, []);
});

// ── T1b ───────────────────────────────────────────────────────────────────────────────────────
check("T1b the two reclassified sites map to decline_source_health", () => {
  const inv = buildInventory(ROOT);
  const sites = inv.decisionSites.filter((s) => s.outcome.reason === "required_component_unavailable");
  assert.strictEqual(sites.length, 2,
    "exactly two sites carry their own prerequisite probe and therefore prove a required " +
    "component absent before any answer is attempted");
  const row = OUTCOME_CATALOG.find((e) => e.reason === "required_component_unavailable")!;
  assert.strictEqual(row.action, "decline_source_health");
  assert.strictEqual(OUTCOME_CATALOG.filter((e) => e.action === "decline_source_health").length, 1,
    "one code covers both producers; splitting it is a reporting decision, not a contract change");
});

// ── T1c ───────────────────────────────────────────────────────────────────────────────────────
check("T1c the catalog is the sole authority for the store partition", () => {
  // 23 P2.1 query_log pairs plus the four query_log-only integration rows; shared_charts is unchanged.
  assert.strictEqual(admissiblePairs("query_log").length, 27);
  assert.strictEqual(admissiblePairs("shared_charts").length, 2);
  for (const reason of ["measure_ambiguous", "followup_ambiguous", "reporting_coverage_insufficient", "annual_result_not_supported"]) {
    assert.ok(!admissiblePairs("shared_charts").some((p) => p.reason === reason), `${reason} is query_log only`);
  }
  assert.ok(isAdmissiblePair("shared_charts", "answer", "stored_artifact_replay"));
  assert.ok(!isAdmissiblePair("query_log", "answer", "stored_artifact_replay"),
    "a shared_charts-only reason must fail the query_log pair set");
  assert.ok(!isAdmissiblePair("shared_charts", "answer", "deterministic_plan"));
  assert.ok(isAdmissiblePair("query_log", "decline_data", "no_rows_in_source"));
  assert.ok(isAdmissiblePair("shared_charts", "decline_data", "no_rows_in_source"),
    "one row, spelled once, admissible in both stores");
  const shared = OUTCOME_CATALOG.filter((e) => e.stores.length === 2);
  assert.strictEqual(shared.length, 1, "exactly one reason is shared between the stores");
  for (const e of OUTCOME_CATALOG) {
    assert.ok(e.stores.length >= 1, `${e.reason} must name at least one store`);
    for (const s of e.stores) assert.ok((OUTCOME_STORES as readonly string[]).includes(s));
  }
});

check("T1c there is no second store-membership list", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/proof-contract.ts"), "utf8");
  const storeLiterals = src.match(/"(query_log|shared_charts)"/g) || [];
  // Occurrences live in: the OutcomeStore union (2), the OUTCOME_STORES constant (2), the
  // catalog's own `stores` tuples (29 across 28 rows, one row naming both), and the two
  // per-store type aliases (2). Anything beyond that is a second authority.
  const inCatalog = (src.match(/stores: \[[^\]]*\]/g) || [])
    .reduce((n, s) => n + (s.match(/"(query_log|shared_charts)"/g) || []).length, 0);
  assert.strictEqual(inCatalog, 29, "28 rows, one of which names both stores");
  assert.ok(storeLiterals.length - inCatalog <= 6,
    `store names appear ${storeLiterals.length - inCatalog} times outside the catalog; a second ` +
    `membership table, switch or array re-creates the two-carriers defect`);
  assert.doesNotMatch(src, /QUERY_LOG_REASONS|SHARED_CHARTS_REASONS|REASONS_BY_STORE/,
    "a hand-maintained per-store list is exactly what the catalog replaced");
});

// ── T2 ────────────────────────────────────────────────────────────────────────────────────────
check("T2 the four shared strings equal their OmissionReason counterparts", () => {
  assert.strictEqual(OUTCOME_OMISSION_SHARED_STRINGS.length, 4);
  for (const shared of OUTCOME_OMISSION_SHARED_STRINGS) {
    assert.ok((REASON_CODES as readonly string[]).includes(shared),
      `${shared} must be a reason code`);
    assert.ok((OMISSION_REASONS as readonly string[]).includes(shared as OmissionReason),
      `${shared} must still be an OmissionReason — a rename on either side must fail here rather ` +
      `than silently forking the vocabulary`);
  }
});

// ── T3 ────────────────────────────────────────────────────────────────────────────────────────
check("T3 gate off: outcome columns are all NULL", () => {
  const f = finalizeProof(baseInput());
  assert.deepStrictEqual(outcomeLogFields(decisionRecord(f), OFF), EMPTY_OUTCOME_LOG_FIELDS);
  assert.deepStrictEqual(outcomeLogFields(OPERATIONAL_RECORD, OFF), EMPTY_OUTCOME_LOG_FIELDS);
});

check("T3 gate off: the built row is byte-identical to the baseline release's", () => {
  const { dir, file } = tmpDb();
  try {
    const db = baselineQueryLog(file);
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const f = finalizeProof(baseInput());
    const row = { ts: 1, tab: "current", question: "q", sql: "SELECT 1", rows: 1, error: null,
                  ms: 5, response: null, guardrails: null, model: null, session_id: null,
                  routing_confidence: null, routing_mode: null, routing_reason: null,
                  query_guidance: null, query_contract: null };
    const withGateOff = buildQueryLogInsert(db, { ...row, ...proofLogFields(f),
      ...outcomeLogFields(decisionRecord(f), OFF) });
    const baseline = buildQueryLogInsert(db, { ...row, ...proofLogFields(null),
      ...EMPTY_OUTCOME_LOG_FIELDS });
    assert.deepStrictEqual(withGateOff!.sql, baseline!.sql);
    assert.deepStrictEqual(withGateOff!.values, baseline!.values,
      "an off-mode deployment must write rows byte-identical to the baseline release's");
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check("T3 gate on with PROOF_MODE unset: outcome columns write, all five proof columns stay NULL", () => {
  const f = finalizeProof(baseInput({ env: OFF }));
  const outcome = outcomeLogFields(decisionRecord(f), ON);
  assert.strictEqual(outcome.record_kind, "decision");
  assert.strictEqual(outcome.delivery_action, "answer");
  assert.strictEqual(outcome.reason_code, "deterministic_plan");
  assert.deepStrictEqual(Object.keys(outcome).sort(),
    ["delivery_action", "reason_code", "record_kind"],
    "the outcome projector owns exactly three columns; stamping a proof-owned one here would be " +
    "the first quiet claim that proof material was persisted");
  const proof = proofLogFields(f);
  assert.deepStrictEqual(proof, {
    proof_manifest: null, result_digest: null, proof_schema_version: null,
    proof_mode: null, plan_family: null,
  }, "stamping proof_schema_version while both members are NULL would assert that proof material " +
     "was persisted; it was not");
});

check("T3 an operational row carries record_kind only", () => {
  const outcome = outcomeLogFields(OPERATIONAL_RECORD, ON);
  assert.deepStrictEqual(outcome,
    { record_kind: "operational", delivery_action: null, reason_code: null });
});

// ── T4 ────────────────────────────────────────────────────────────────────────────────────────
check("T4 an out-of-vocabulary value nulls only the outcome columns and keeps the base row", () => {
  const { dir, file } = tmpDb();
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  try {
    const db = baselineQueryLog(file);
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const f = finalizeProof(baseInput());
    // Force the pair out of vocabulary the way untyped JavaScript or a corrupted value would.
    const corrupted = { ...f, decision: { ...f.decision, reason: "not_a_real_reason" } } as
      unknown as ProofFinalization;
    const outcome = outcomeLogFields(decisionRecord(corrupted), ON);
    assert.strictEqual(outcome.delivery_action, null, "degrade, never throw");
    assert.strictEqual(outcome.reason_code, null);
    assert.strictEqual(outcome.record_kind, "decision",
      "the row is still classified, so it surfaces as a coverage violation rather than as an " +
      "accepted bad code");
    assert.ok(errors.length > 0, "the degradation must be logged");
    const insert = buildQueryLogInsert(db, {
      ts: 1, tab: "current", question: "the question survives", sql: "SELECT 1", rows: 1,
      error: null, ms: 5, response: "the response survives", guardrails: null, model: null,
      session_id: null, routing_confidence: null, routing_mode: null, routing_reason: null,
      query_guidance: null, query_contract: null, ...proofLogFields(f), ...outcome });
    db.prepare(insert!.sql).run(...insert!.values);
    const stored = db.prepare("SELECT question, response, reason_code FROM query_log").get() as
      { question: string; response: string; reason_code: string | null };
    assert.strictEqual(stored.question, "the question survives",
      "losing the row would lose strictly more than losing the outcome");
    assert.strictEqual(stored.response, "the response survives");
    assert.strictEqual(stored.reason_code, null);
    db.close();
  } finally {
    console.error = realError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── T5 ────────────────────────────────────────────────────────────────────────────────────────
check("T5 the migration is idempotent and adds only the two new columns to a six-column table", () => {
  const { dir, file } = tmpDb();
  try {
    const db = baselineQueryLog(file);
    for (const c of ["delivery_action TEXT", "proof_manifest TEXT", "result_digest TEXT",
                     "proof_schema_version INTEGER", "proof_mode TEXT", "plan_family TEXT"]) {
      db.exec(`ALTER TABLE query_log ADD COLUMN ${c}`);
    }
    db.prepare("INSERT INTO query_log (ts, tab, question) VALUES (1, 'current', 'q')").run();
    db.close();
    const first = queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    assert.deepStrictEqual(first.columnsChanged.sort(), ["reason_code", "record_kind"],
      "only the two new entries are added against a database that already carries the other six");
    const second = queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    assert.strictEqual(second.changed, false, "a second run must be a no-op");
    const db2 = new Database(file);
    assert.strictEqual((db2.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n, 1,
      "row count preserved");
    assert.strictEqual((db2.pragma("integrity_check") as { integrity_check: string }[])[0]
      .integrity_check, "ok");
    db2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check("T5 rollback drops the index before the columns and preserves rows", () => {
  const { dir, file } = tmpDb();
  try {
    baselineQueryLog(file).close();
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const db = new Database(file);
    db.prepare("INSERT INTO query_log (ts, tab, question) VALUES (1, 'current', 'q')").run();
    db.close();
    const back = queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: true });
    assert.ok(back.changed);
    const db2 = new Database(file);
    const cols = (db2.pragma("table_info(query_log)") as { name: string }[]).map((c) => c.name);
    for (const gone of ["record_kind", "reason_code", "delivery_action"]) {
      assert.ok(!cols.includes(gone), `${gone} must be dropped`);
    }
    assert.strictEqual((db2.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n, 1,
      "rollback must not lose rows");
    assert.strictEqual((db2.pragma("integrity_check") as { integrity_check: string }[])[0]
      .integrity_check, "ok");
    db2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T6 ────────────────────────────────────────────────────────────────────────────────────────
check("T6 the outcome columns are registered as migrated columns", () => {
  // lib/query-log-columns.ts exists because three hand-maintained sequences desynchronized and
  // every log write was silently lost. A column the application may write must be declared here.
  for (const column of ["record_kind", "reason_code", "delivery_action"]) {
    assert.ok((QUERY_LOG_MIGRATED_COLUMNS as readonly string[]).includes(column),
      `${column} must be declared as a migrated column`);
  }
});

check("T6 deploy-order tolerance: migrated code + unmigrated database writes the legacy set", () => {
  const { dir, file } = tmpDb();
  try {
    const db = baselineQueryLog(file);   // deliberately NOT migrated
    const f = finalizeProof(baseInput());
    const insert = buildQueryLogInsert(db, {
      ts: 1, tab: "current", question: "q", sql: null, rows: 0, error: null, ms: 1,
      response: null, guardrails: null, model: null, session_id: null, routing_confidence: null,
      routing_mode: null, routing_reason: null, query_guidance: null, query_contract: null,
      ...proofLogFields(f), ...outcomeLogFields(decisionRecord(f), ON) });
    assert.ok(insert, "the write must still happen");
    assert.ok(!insert!.sql.includes("record_kind"),
      "columns the live table lacks are dropped, so enabling the gate before migrating writes the " +
      "legacy set and loses no row");
    db.prepare(insert!.sql).run(...insert!.values);
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n, 1);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check("T6 deploy-order tolerance: unmigrated code + migrated database leaves the columns NULL", () => {
  const { dir, file } = tmpDb();
  try {
    baselineQueryLog(file).close();
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const db = new Database(file);
    // "Unmigrated code" = a writer that supplies none of the outcome fields.
    const insert = buildQueryLogInsert(db, {
      ts: 1, tab: "current", question: "q", sql: null, rows: 0, error: null, ms: 1,
      response: null, guardrails: null, model: null, session_id: null, routing_confidence: null,
      routing_mode: null, routing_reason: null, query_guidance: null, query_contract: null });
    db.prepare(insert!.sql).run(...insert!.values);
    const row = db.prepare("SELECT record_kind, reason_code, delivery_action FROM query_log").get() as
      Record<string, unknown>;
    assert.deepStrictEqual(row, { record_kind: null, reason_code: null, delivery_action: null });
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T7e ───────────────────────────────────────────────────────────────────────────────────────
check("T7e outcomeLogFields accepts only the discriminated record", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/proof-finalize.ts"), "utf8");
  assert.match(src, /export type OutcomeLogRecord =\s*\|\s*\{ kind: "decision"; finalization: ProofFinalization \}\s*\|\s*\{ kind: "operational" \}/,
    "a positional (finalization, recordKind) pair would let a decision arrive with no " +
    "finalization and an operational record arrive carrying one");
  assert.match(src, /export function outcomeLogFields\(\s*\n?\s*record: OutcomeLogRecord \| null,/,
    "the projector takes ONE discriminated record, never two positional arguments");
  // The two shapes are structurally disjoint at runtime too.
  assert.strictEqual(asOutcomeRecord(OPERATIONAL_RECORD), OPERATIONAL_RECORD);
  const f = finalizeProof(baseInput());
  assert.deepStrictEqual(asOutcomeRecord(f), { kind: "decision", finalization: f });
  assert.strictEqual(asOutcomeRecord(null), null);
});

// ── T7f ───────────────────────────────────────────────────────────────────────────────────────
check("T7f the reason survives finalization for every producible query_log pair", () => {
  for (const pair of admissiblePairs("query_log")) {
    const outcome = OUTCOMES[pair.reason as keyof typeof OUTCOMES];
    const f = finalizeProof(baseInput({ outcome }));
    assert.strictEqual(f.decision.action, pair.action, `${pair.reason} action`);
    assert.strictEqual(f.decision.reason, pair.reason,
      `${pair.reason} must reach the finalization; without a carrier the projector has nothing to read`);
    const projected = outcomeLogFields(decisionRecord(f), ON);
    assert.strictEqual(projected.reason_code, pair.reason,
      "the reason supplied at the exit must be byte-identical to the reason projected");
    assert.strictEqual(projected.delivery_action, pair.action);
  }
});

check("T7f the reason survives off mode and the degraded inert path", () => {
  const off = finalizeProof(baseInput({ env: OFF, outcome: OUTCOMES.guardrail_block }));
  assert.strictEqual(off.mode, "off");
  assert.strictEqual(off.decision.reason, "guardrail_block",
    "off mode returns an inert finalization; dropping the reason there would make off-mode and " +
    "degraded rows silently reason-less, which is the hardest place to notice it");
  assert.strictEqual(outcomeLogFields(decisionRecord(off), ON).reason_code, "guardrail_block");
  // A degraded finalization: a shadow run whose inputs force the inert path.
  const degraded = finalizeProof(baseInput({
    env: { PROOF_MODE: "shadow" }, outcome: OUTCOMES.model_produced_no_sql,
    sql: null, rows: [], columns: [] }));
  assert.strictEqual(degraded.decision.reason, "model_produced_no_sql");
});

// ── T8 ────────────────────────────────────────────────────────────────────────────────────────
const COVERAGE_SQL = `
SELECT COUNT(*) AS violations FROM query_log
WHERE ts >= :activation_ts
  AND (   record_kind IS NULL
       OR record_kind NOT IN ('decision','operational')
       OR (record_kind = 'decision'    AND (delivery_action IS NULL     OR reason_code IS NULL))
       OR (record_kind = 'operational' AND (delivery_action IS NOT NULL OR reason_code IS NOT NULL)) )`;

function admissibleCte(store: "query_log" | "shared_charts"): string {
  return admissiblePairs(store).map((p) => `('${p.action}','${p.reason}')`).join(", ");
}

check("T8 coverage simulation: pre-activation NULLs plus post-activation rows return 0", () => {
  const { dir, file } = tmpDb();
  try {
    baselineQueryLog(file).close();
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const db = new Database(file);
    const ins = db.prepare(
      "INSERT INTO query_log (ts, tab, question, record_kind, delivery_action, reason_code) " +
      "VALUES (?, 'current', 'q', ?, ?, ?)");
    ins.run(100, null, null, null);                                   // pre-activation
    ins.run(200, "decision", "answer", "deterministic_plan");          // post-activation decision
    ins.run(201, "operational", null, null);                          // post-activation operational
    const v = db.prepare(COVERAGE_SQL).get({ activation_ts: 150 }) as { violations: number };
    assert.strictEqual(v.violations, 0);
    const pairSql = `WITH admissible(action, reason) AS (VALUES ${admissibleCte("query_log")})
      SELECT COUNT(*) AS violations FROM query_log q
      WHERE q.ts >= :activation_ts AND q.record_kind = 'decision'
        AND NOT EXISTS (SELECT 1 FROM admissible a
                        WHERE a.action = q.delivery_action AND a.reason = q.reason_code)`;
    assert.strictEqual((db.prepare(pairSql).get({ activation_ts: 150 }) as { violations: number })
      .violations, 0);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check("T8 the coverage query fails in BOTH directions", () => {
  const { dir, file } = tmpDb();
  try {
    baselineQueryLog(file).close();
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const db = new Database(file);
    const ins = db.prepare(
      "INSERT INTO query_log (ts, tab, question, record_kind, delivery_action, reason_code) " +
      "VALUES (?, 'current', 'q', ?, ?, ?)");
    ins.run(200, "operational", "answer", null);        // operational carrying an outcome
    assert.strictEqual((db.prepare(COVERAGE_SQL).get({ activation_ts: 150 }) as
      { violations: number }).violations, 1, "an operational row that fabricates an outcome fails");
    db.prepare("DELETE FROM query_log").run();
    ins.run(200, "decision", "answer", null);           // decision missing its reason
    assert.strictEqual((db.prepare(COVERAGE_SQL).get({ activation_ts: 150 }) as
      { violations: number }).violations, 1, "a decision row missing an outcome fails");
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check("T8 the embed validity query is activation-bounded and pair-validating", () => {
  const { dir } = tmpDb();
  const file = path.join(dir, "shared.db");
  try {
    const db = new Database(file);
    db.exec(`CREATE TABLE shared_charts (id TEXT PRIMARY KEY, last_read_delivery_action TEXT,
             last_read_reason_code TEXT, last_read_at INTEGER)`);
    // A pre-activation read: an action and a timestamp, no reason, because nothing was backfilled.
    db.prepare("INSERT INTO shared_charts VALUES ('old', 'answer', NULL, 100)").run();
    db.prepare("INSERT INTO shared_charts VALUES ('new', 'answer', 'stored_artifact_replay', 200)").run();
    const sql = `WITH admissible(action, reason) AS (VALUES ${admissibleCte("shared_charts")})
      SELECT COUNT(*) AS violations FROM shared_charts s
      WHERE s.last_read_at >= :activation_ts
        AND NOT EXISTS (SELECT 1 FROM admissible a
                        WHERE a.action = s.last_read_delivery_action
                          AND a.reason = s.last_read_reason_code)`;
    assert.strictEqual((db.prepare(sql).get({ activation_ts: 150 }) as { violations: number })
      .violations, 0, "without the activation bound the whole existing population would fail on " +
      "day one, which would be a self-inflicted red gate");
    // A mismatched pair must fail even though both columns are non-NULL.
    db.prepare("INSERT INTO shared_charts VALUES ('bad', 'answer', 'no_rows_in_source', 300)").run();
    assert.strictEqual((db.prepare(sql).get({ activation_ts: 150 }) as { violations: number })
      .violations, 1, "checking both non-NULL is not enough: the PAIR must be admissible");
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T9 ────────────────────────────────────────────────────────────────────────────────────────
check("T9 a pre-activation NULL row is neither covered nor a violation", () => {
  const { dir, file } = tmpDb();
  try {
    baselineQueryLog(file).close();
    queryLogMigration.migrate({ dbPath: file, dryRun: false, rollback: false });
    const db = new Database(file);
    const ins = db.prepare("INSERT INTO query_log (ts, tab, question) VALUES (?, 'current', 'q')");
    ins.run(100); ins.run(120);
    const at = (t: number) => (db.prepare(COVERAGE_SQL).get({ activation_ts: t }) as
      { violations: number }).violations;
    assert.strictEqual(at(150), 0, "old rows are outside the measurement, not scored and forgiven");
    assert.strictEqual(at(50), 2, "moving activation_ts moves only the boundary");
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T11 ───────────────────────────────────────────────────────────────────────────────────────
check("T11 PROOF_KILL_SWITCH disengages outcome logging as well as proof observation", () => {
  assert.strictEqual(outcomeLoggingEnabled({ OUTCOME_LOG: "on" }), true);
  assert.strictEqual(outcomeLoggingEnabled({ OUTCOME_LOG: "on", PROOF_KILL_SWITCH: "1" }), false,
    "one stop-everything lever");
  assert.strictEqual(outcomeWritesEnabled({ OUTCOME_LOG: "on", PROOF_KILL_SWITCH: "true" }, "shadow"),
    false, "the kill switch must beat shadow-implies-outcome too");
  const f = finalizeProof(baseInput());
  assert.deepStrictEqual(
    outcomeLogFields(decisionRecord(f), { OUTCOME_LOG: "on", PROOF_KILL_SWITCH: "on" }),
    EMPTY_OUTCOME_LOG_FIELDS);
});

check("T11 the gate defaults off and fails toward off", () => {
  for (const raw of [undefined, "", "  ", "maybe", "0", "false", "off"]) {
    assert.strictEqual(outcomeLoggingEnabled({ OUTCOME_LOG: raw }), false, `OUTCOME_LOG=${raw}`);
  }
  for (const raw of ["1", "true", "on", "yes", " ON "]) {
    assert.strictEqual(outcomeLoggingEnabled({ OUTCOME_LOG: raw }), true, `OUTCOME_LOG=${raw}`);
  }
});

check("T11 shadow implies outcome logging; outcome logging never implies proof work", () => {
  assert.strictEqual(outcomeWritesEnabled({}, "shadow"), true);
  assert.strictEqual(outcomeWritesEnabled({}, "off"), false);
  assert.strictEqual(outcomeWritesEnabled({ OUTCOME_LOG: "on" }, "off"), true);
  const f = finalizeProof(baseInput({ env: OFF }));
  assert.strictEqual(proofLogFields(f).proof_mode, null,
    "outcome activation runs no check, no digest, no probe, and writes no proof-owned column");
});

// ── privacy ───────────────────────────────────────────────────────────────────────────────────
check("no request content can reach the outcome columns", () => {
  const f = finalizeProof(baseInput({ question: "murders in Sensitive Place 12345" }));
  const outcome = outcomeLogFields(decisionRecord(f), ON);
  for (const value of Object.values(outcome)) {
    if (value === null) continue;
    assert.ok(
      (REASON_CODES as readonly string[]).includes(value as string) ||
      (DELIVERY_ACTIONS as readonly string[]).includes(value as string) ||
      ["decision", "operational"].includes(value as string),
      `${String(value)} is not a member of a closed vocabulary`);
  }
});

console.log(`\n${passed} checks passed`);
