/**
 * AST inventory assertions for the typed-outcome layer — P2.1 §4.7 T7a, T7b, T7c-i, T7c-ii, T7d,
 * T7g and T10.
 *
 * NOTHING HERE MATCHES SOURCE TEXT. Every assertion runs over the TypeScript AST via
 * scripts/lib/exit-inventory.js, and every site is addressed by a structural fingerprint rather
 * than a committed line number. P2.2 adds arguments and branches to these files, so a tracked
 * assertion keyed to a line would fail on its own first commit.
 *
 * PRODUCTION IS NEVER TOUCHED. This reads source files and asserts; it opens no database, makes no
 * request, and runs no migration.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildInventory } = require("./lib/exit-inventory.js") as {
  buildInventory: (repoRoot: string) => {
    routes: { route: string; sealSiteCount: number; sites: Site[]; operational: OperationalRow[];
              loggerClosures: { name: string; projectsBoth: boolean; carrier: string | null;
                                proofCarrier: string | null; outcomeCarrier: string | null;
                                reason: string | null }[] }[];
    embed: { sites: Site[]; source: string };
    decisionSites: Site[];
    operationalRows: OperationalRow[];
    unsealedSites: Site[];
    unpairedDecisionSites: Site[];
    sealSiteTotal: number;
  };
};

interface Pairing { kind: string; loggerLines: number[] }
interface Site {
  route: string; file: string; line: number; fingerprint: string; sealed: boolean;
  pairing: Pairing;
  outcome: { form: string; reason?: string; whenTrue?: string; whenFalse?: string; predicate?: string };
  planFamily: string | null; guardrails: string | null;
  termination: { terminal: boolean; conditional: boolean; how: string };
}
interface OperationalRow {
  route: string; file: string; line: number; fingerprint: string; inClosure: boolean;
  termination: { terminal: boolean; conditional: boolean; how: string };
}

const ROOT = path.resolve(__dirname, "..");
const inv = buildInventory(ROOT);

/**
 * The accepted P2.1 semantic sets, plus the accepted Phase 3 exits added when that candidate was integrated
 * (2026-09-30, Codex Gate A vocabulary ruling). These are the numbers the owner approved, not observations.
 *
 * P2.1: 96 decision sites (query 29, nibrs-query 24, shr-query 28, hc-query 15) and 19 operational rows.
 * Integration adds 22 decision sites and 2 operational rows, enumerated site by site against a clean dev
 * checkout (audit/phase3-integration-2026-09-30/prep/exit-enumeration.json); none of dev's sites was removed:
 *   query (+6):       crime-type clarify (measure_ambiguous); current-amendment clarify (followup_ambiguous);
 *                     city-ranking unavailable + owned failure (capability_path_unavailable x2); city ranking and
 *                     current year-over-year (deterministic_plan | no_rows_in_source x2).
 *   nibrs-query (+11): crime-type clarify (measure_ambiguous); where-level clarify (geography_scope_ambiguous);
 *                     category change (reporting_coverage_insufficient | capability_path_unavailable) and its answer
 *                     (deterministic_plan); ranking structural refusal (sql_shape_rejected); annual family
 *                     (annual_result_not_supported | capability_path_unavailable) and its answer (deterministic_plan);
 *                     member coverage refusals (geography_contract_violation x3); owned multi-agency
 *                     (capability_path_unavailable).
 *   shr-query (+5):   county scope (geography_scope_ambiguous | capability_path_unavailable); crime-type and
 *                     shooting-scope clarify (measure_ambiguous x2); city ranking (deterministic_plan |
 *                     no_rows_in_source); owned count (deterministic_plan | all_values_null).
 *   operational (+2): the SHR city-ranking and owned-count database-error catches (OPERATIONAL_RECORD).
 * SHR agency/year classification (Codex combined ruling, 2026-10-02), shr-query (+2): the limited answer when a
 * City/County-dependent statement matched no classified agency while unclassified agencies are in its scope, on the
 * model path and on the deterministic name-match fallback (reporting_coverage_insufficient x2) -- never an apparent zero.
 * Request accounting, stage 1 (plan docs/superpowers/plans/2026-10-07-request-accounting-stage1.md), shr-query (+1): the
 * recognition gate's decline when a part of the request is not recorded in SHR or could not be interpreted
 * (capability_path_unavailable), before every answer planner -- never a broader number in its place.
 * Request accounting plan r2.1, shr-query (+1 decision, +1 operational): the owned request-plan answer
 * (deterministic_plan | all_values_null) and its database-error catch (OPERATIONAL_RECORD).
 */
// GC-051 batch (2026-10-07), query (+2): the owned Current month-coverage exit (lib/current-month-coverage.ts) -- a failed
// check (sql_shape_rejected | capability_path_unavailable) and its result (deterministic_plan | no_rows_in_source).
const EXPECTED = {
  decisionSites: 124, // 120 + request accounting stage 1 (2) + GC-051 (2)
  sealSites: 124, // 120 + request accounting stage 1 (2) + GC-051 (2)
  operationalRows: 22,
  perRouteSealSites: { query: 37, "nibrs-query": 35, "shr-query": 37, "hc-query": 15 },
  /** §2.4(ii): exactly one operational row is not an unconditionally terminal path. */
  nonTerminalOperationalRows: 1,
  /** §2.4(ii): exactly one terminates by closing the SSE stream rather than by returning. */
  streamClosureTerminations: 1,
  /** 122 exits log through their route-local closure (118 + request accounting's two + GC-051's two month-coverage exits); the two source-switch exits call directly. */
  closurePairedSites: 122,
  directPairedSites: 2,
};

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("outcome inventory (AST)");

// ── T7a ───────────────────────────────────────────────────────────────────────────────────────
check("T7a every decision exit supplies an outcome, and decisions == sealed exits", () => {
  assert.strictEqual(inv.decisionSites.length, EXPECTED.decisionSites,
    `expected ${EXPECTED.decisionSites} decision exits, found ${inv.decisionSites.length}`);
  assert.strictEqual(inv.sealSiteTotal, EXPECTED.sealSites,
    "the seal-site count and the decision-exit count are two independent measurements of the " +
    "same set; if they disagree the eligibility boundary has moved");
  for (const [route, want] of Object.entries(EXPECTED.perRouteSealSites)) {
    const r = inv.routes.find((x) => x.route === route)!;
    assert.strictEqual(r.sealSiteCount, want, `${route} seal sites`);
  }
  const missing = inv.decisionSites.filter((s) => s.outcome.form === "absent");
  assert.deepStrictEqual(missing.map((s) => s.fingerprint), [],
    "a sealed exit with no outcome would persist a decision row with a NULL outcome");
  const unresolved = inv.decisionSites.filter((s) => s.outcome.form === "unresolved" ||
    s.outcome.form === "other");
  assert.deepStrictEqual(unresolved.map((s) => s.fingerprint), [],
    "every outcome must resolve to catalog constants");
});

check("T7a no exit site is left unsealed and unclassified", () => {
  assert.deepStrictEqual(inv.unsealedSites.map((s) => s.fingerprint), [],
    "an exit that neither seals a payload nor is marked operational is unclassified");
});

// ── T7a-pairing — the correction round 1 required ─────────────────────────────────────────────
check("T7a-pairing every decision exit's row actually persists its outcome", () => {
  // COUNTING FINALIZERS IS NOT ENOUGH, and this is the assertion whose absence let two real
  // bypasses through review. `emitFactualPayload` proves an exit COMPUTED an outcome; it says
  // nothing about whether the row that exit writes PERSISTS it. Two source-switch exits called
  // `logQuery` directly with `proofLogFields(...)` and no outcome projector, so their decision
  // rows would have carried a NULL record_kind after activation while every route-level check
  // stayed green.
  const failures = inv.unpairedDecisionSites.map(
    (s) => `${s.route}:${s.line} (${s.pairing.kind})`);
  assert.deepStrictEqual(failures, [],
    "every decision exit must reach a logger that projects BOTH proofLogFields(decisionFinalization(…)) " +
    "and outcomeLogFields(asOutcomeRecord(…)) from the same finalization");
  assert.strictEqual(inv.decisionSites.length, EXPECTED.decisionSites);
  for (const site of inv.decisionSites) {
    assert.ok(["closure", "direct-both"].includes(site.pairing.kind),
      `${site.route}:${site.line} pairs as ${site.pairing.kind}`);
    assert.ok(site.pairing.loggerLines.length > 0,
      `${site.route}:${site.line} must name the logger call that carries it`);
  }
});

check("T7a-pairing both admissible pairing forms are actually present", () => {
  const kinds = new Map<string, number>();
  for (const s of inv.decisionSites) kinds.set(s.pairing.kind, (kinds.get(s.pairing.kind) ?? 0) + 1);
  assert.strictEqual(kinds.get("closure"), EXPECTED.closurePairedSites,
    "most exits log through the route-local closure");
  assert.strictEqual(kinds.get("direct-both"), EXPECTED.directPairedSites,
    "the source-switch exits bypass the closure and must supply both projectors themselves; if " +
    "this count drops the direct calls have regressed to one projector");
});

check("T7a-pairing every route closure projects both FROM THE SAME carrier", () => {
  // Containing both wrapper chains is not the property that matters; receiving the same carrier
  // is. Two independent booleans would accept
  //     proofLogFields(decisionFinalization(proof)), outcomeLogFields(asOutcomeRecord(null))
  // which writes a real proof projection beside an all-NULL outcome while every exit using the
  // closure still classifies as paired. That is the round-1 false acceptance one indirection
  // deeper, and it is what these assertions close.
  for (const route of inv.routes) {
    assert.ok(route.loggerClosures.length > 0, `${route.route} must declare a logging closure`);
    for (const c of route.loggerClosures) {
      assert.ok(c.carrier,
        `${route.route}'s ${c.name} must declare a parameter accepting ` +
        `ProofFinalization | OutcomeLogRecord`);
      assert.ok(c.projectsBoth, `${route.route}'s ${c.name}: ${c.reason}`);
      assert.strictEqual(c.proofCarrier, c.carrier,
        `${route.route}'s ${c.name}: proofLogFields must receive decisionFinalization(${c.carrier})`);
      assert.strictEqual(c.outcomeCarrier, c.carrier,
        `${route.route}'s ${c.name}: outcomeLogFields must receive asOutcomeRecord(${c.carrier})`);
      assert.strictEqual(c.proofCarrier, c.outcomeCarrier,
        `${route.route}'s ${c.name}: both projections must come from one carrier`);
    }
  }
});

// ── T7b ───────────────────────────────────────────────────────────────────────────────────────
check("T7b computed sites select between whole Outcome constants, never parallel ternaries", () => {
  const parallel = inv.decisionSites.filter((s) => s.outcome.form === "parallel");
  assert.deepStrictEqual(parallel.map((s) => s.fingerprint), [],
    "a conditional whose arms are not whole OUTCOMES constants can desynchronize action " +
    "from reason, which is the defect the discriminated union exists to prevent");
  const computed = inv.decisionSites.filter(
    (s) => s.outcome.form === "computed" || s.outcome.form === "hoisted");
  // P2.1 measured 11; the integration adds the 7 computed candidate sites enumerated at EXPECTED (query 2,
  // nibrs-query 2, shr-query 3), each a choice between two whole OUTCOMES constants with its own predicate.
  // Request accounting plan r2.1 adds 1: the owned request-plan answer (deterministic_plan | all_values_null).
  // GC-051 batch: +2 (query), the month-coverage failed check and its result, each a choice between two whole constants.
  assert.strictEqual(computed.length, 21, "P2.1's 11 computed sites, the 7 integrated candidate sites, the request-plan answer and GC-051's 2");
  for (const s of computed) {
    assert.ok(s.outcome.whenTrue && s.outcome.whenFalse, `${s.fingerprint} needs two arms`);
    assert.ok(s.outcome.predicate, `${s.fingerprint} must carry its own predicate`);
  }
  assert.strictEqual(computed.filter((s) => s.outcome.form === "hoisted").length, 1,
    "one site hoists its outcome into a local const and passes it as a shorthand property; " +
    "that is the site a grep pass missed entirely");
});

// ── T7c-i ─────────────────────────────────────────────────────────────────────────────────────
check("T7c-i the operational logging sites are exactly the declared 19", () => {
  assert.strictEqual(inv.operationalRows.length, EXPECTED.operationalRows,
    `expected ${EXPECTED.operationalRows} operational rows, found ${inv.operationalRows.length}`);
  for (const row of inv.operationalRows) {
    assert.ok(!row.inClosure, `${row.fingerprint} must be an exit site, not a closure body`);
  }
});

check("T7c-i no operational site supplies an outcome", () => {
  // An operational row asserts no product decision. If one of these sites also finalized an
  // outcome it would fabricate one, which is exactly what the 16 pre-P2.2 sites were doing when
  // they claimed decline_capability for a database error.
  const sealedOperational = inv.operationalRows.filter((row) =>
    inv.decisionSites.some((s) => s.route === row.route && Math.abs(s.line - row.line) <= 1));
  assert.deepStrictEqual(sealedOperational.map((r) => r.fingerprint), [],
    "an operational row must not sit on a sealed decision exit");
});

// ── T7c-ii ────────────────────────────────────────────────────────────────────────────────────
check("T7c-ii branch level: SSE stream closure counts as termination", () => {
  const byClosure = inv.operationalRows.filter((r) => r.termination.how.startsWith("stream-close"));
  assert.ok(byClosure.length >= EXPECTED.streamClosureTerminations,
    "at least one operational path ends by closing the SSE stream rather than by returning; a " +
    "predicate that demanded a `return` would wrongly report it as non-terminating");
  const viaFinally = inv.operationalRows.filter((r) => r.termination.how === "stream-close-finally");
  assert.strictEqual(viaFinally.length, EXPECTED.streamClosureTerminations,
    "the SSE outer catch closes the stream in the enclosing try's finally block");
});

check("T7c-ii branch level: exactly one operational site is not unconditionally terminal", () => {
  const nonTerminal = inv.operationalRows.filter((r) => !r.termination.terminal);
  assert.strictEqual(nonTerminal.length, EXPECTED.nonTerminalOperationalRows,
    `expected exactly ${EXPECTED.nonTerminalOperationalRows} mid-flight operational site, found ` +
    nonTerminal.map((r) => r.fingerprint).join(", "));
  const midFlight = nonTerminal[0];
  assert.ok(midFlight.termination.conditional,
    "the mid-flight site writes its row on every pass and returns on one branch only, so one " +
    "request can write two rows: rows are not requests");
  assert.strictEqual(midFlight.route, "nibrs-query");
});

// ── T7d ───────────────────────────────────────────────────────────────────────────────────────
check("T7d the embed read finalizes from its own rows predicate", () => {
  assert.strictEqual(inv.embed.sites.length, 1, "the embed read has exactly one finalization");
  const site = inv.embed.sites[0];
  assert.strictEqual(site.outcome.form, "computed");
  assert.strictEqual(site.outcome.whenTrue, "stored_artifact_replay");
  assert.strictEqual(site.outcome.whenFalse, "no_rows_in_source");
  assert.match(site.outcome.predicate || "", /rows\.length > 0/,
    "the outcome must come from the SAME predicate that determines the behaviour");
});

check("T7d the embed UPDATE writes decision.action and the reason in one statement", () => {
  const src = inv.embed.source;
  const stmt = src.match(/UPDATE shared_charts SET[^"]*/);
  assert.ok(stmt, "the rolling-summary UPDATE must exist");
  assert.match(stmt![0], /last_read_delivery_action = \?/, "the served action is stored");
  assert.match(stmt![0], /last_read_reason_code = \?/,
    "the reason is stored BESIDE the action, in the same statement, so a latest summary cannot " +
    "carry an action from one path and a reason from another");
  assert.match(src, /\.run\(\s*finalization\.decision\.action,\s*finalization\.decision\.reason/,
    "the column is named for the action that was SERVED: decision.action, never hypotheticalAction");
  assert.doesNotMatch(src, /last_read_delivery_action = \?[^;]*\.run\(finalization\.hypotheticalAction/,
    "storing hypotheticalAction in a column named for the served action was the defect here");
});

// ── T7g ───────────────────────────────────────────────────────────────────────────────────────
check("T7g no proof-owned shape gained a field, so PROOF_SCHEMA_VERSION is unchanged", () => {
  const finalizeSrc = fs.readFileSync(path.join(ROOT, "lib/proof-finalize.ts"), "utf8");
  const envelope = finalizeSrc.match(/function serializeProofEnvelope[\s\S]*?\n}/);
  assert.ok(envelope, "serializeProofEnvelope must exist");
  assert.doesNotMatch(envelope![0], /\bdecision\b/,
    "the envelope must not serialize `decision`; adding the reason there WOULD be a schema change");
  const digestSrc = fs.readFileSync(path.join(ROOT, "lib/result-digest.ts"), "utf8");
  assert.doesNotMatch(digestSrc, /decision\.|deliveryAction|delivery_action/,
    "the result digest must not reference the decision or the action");
  assert.doesNotMatch(finalizeSrc, /hypotheticalAction:\s*\{[\s\S]*?reason/,
    "hypotheticalAction stays action-only: it is proof-layer and no exit ever asserted a reason for it");
});

check("T7g the outcome and proof projectors have disjoint column sets", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/proof-finalize.ts"), "utf8");
  const proofIface = src.match(/export interface ProofLogFields \{[\s\S]*?\n\}/)![0];
  const outcomeIface = src.match(/export interface OutcomeLogFields \{[\s\S]*?\n\}/)![0];
  const cols = (block: string) =>
    Array.from(block.matchAll(/^\s{2}(\w+):/gm)).map((m) => m[1]);
  const proofCols = cols(proofIface);
  const outcomeCols = cols(outcomeIface);
  assert.deepStrictEqual(outcomeCols.sort(), ["delivery_action", "reason_code", "record_kind"]);
  assert.deepStrictEqual(
    proofCols.sort(),
    ["plan_family", "proof_manifest", "proof_mode", "proof_schema_version", "result_digest"],
    "the five proof-owned columns and nothing else");
  const overlap = proofCols.filter((c) => outcomeCols.includes(c));
  assert.deepStrictEqual(overlap, [],
    "disjoint column sets are what make the outcome/proof boundary structural rather than procedural");
});

// ── T10 ───────────────────────────────────────────────────────────────────────────────────────
check("T10 the migration source contains no backfill", () => {
  // Asserted over the AST rather than the file text. A text scan for /SET/i matches `new Set(...)`
  // in ordinary JavaScript — the first draft of this check failed for exactly that reason. This
  // walks string and template literals and tests each for a real SQL UPDATE.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require(path.join(ROOT, "node_modules", "typescript"));
  const SQL_UPDATE = /\bUPDATE\s+[\w$.{}]+\s+SET\b/i;
  for (const rel of ["scripts/migrate-query-log-proof.js", "scripts/migrate-shared-charts-proof.js"]) {
    const abs = path.join(ROOT, rel);
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.ES2022, true);
    const offending: string[] = [];
    const visit = (n: import("typescript").Node) => {
      if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
        const text = n.getText(sf);
        if (SQL_UPDATE.test(text)) offending.push(text.slice(0, 140));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.deepStrictEqual(offending, [],
      `${rel} must execute zero UPDATE statements: inferring an action from rows, error, ` +
      `response, guardrails or model is exactly the prose-and-heuristic signal the typed ` +
      `outcome replaces`);
  }
});

check("T10 every row written before activation keeps NULL forever", () => {
  // Asserted over the column DEFINITIONS, not the file text: `IS NOT NULL` appears legitimately
  // in the partial index and in the row-count probes, and a whole-file scan flags those.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queryLog = require(path.join(ROOT, "scripts/migrate-query-log-proof.js")) as {
    COLUMNS: { name: string; type: string }[];
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharedCharts = require(path.join(ROOT, "scripts/migrate-shared-charts-proof.js")) as {
    COLUMNS: { name: string; type: string }[];
  };
  for (const [label, cols] of [["query_log", queryLog.COLUMNS],
                               ["shared_charts", sharedCharts.COLUMNS]] as const) {
    for (const column of cols) {
      assert.match(column.type, /^(TEXT|INTEGER)$/,
        `${label}.${column.name} must be a bare TEXT or INTEGER declaration; it is "${column.type}"`);
      assert.doesNotMatch(column.type, /DEFAULT/i,
        `${label}.${column.name}: a DEFAULT is a silent backfill`);
      assert.doesNotMatch(column.type, /NOT\s+NULL/i,
        `${label}.${column.name} must be nullable — old rows keep NULL forever`);
      assert.doesNotMatch(column.type, /CHECK/i,
        `${label}.${column.name}: no CHECK constraint. Both loggers swallow insert failures, so a ` +
        `rejected value would destroy the whole log row, and losing the row loses strictly more ` +
        `than losing the outcome`);
    }
  }
  const outcomeColumns = queryLog.COLUMNS.map((c) => c.name);
  for (const required of ["record_kind", "reason_code", "delivery_action"]) {
    assert.ok(outcomeColumns.includes(required), `${required} must be in the one migration`);
  }
  assert.ok(sharedCharts.COLUMNS.some((c) => c.name === "last_read_reason_code"),
    "the embed reason column belongs to the migration that already owns that table");
});

console.log(`\n${passed} checks passed`);
