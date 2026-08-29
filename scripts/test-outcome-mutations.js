/**
 * Mutation gates for the typed-outcome layer — P2.1 §4.7.
 *
 * "Every structural assertion (T7*) requires a paired executable mutation that changes the
 * construct and makes the assertion fail." A green suite that cannot go red proves nothing; this
 * file is what makes the outcome tests evidence rather than decoration. Same shape as the existing
 * scripts/test-harness-mutations.js.
 *
 * HOW IT WORKS, AND WHY IT IS SAFE. Each mutation is applied to the real file, the paired test is
 * run as a child process, and the original bytes are restored in a `finally`. Every target's
 * sha256 is captured before the run and re-verified after it, so a crash mid-mutation is reported
 * rather than left in the tree. Nothing is committed and no database or network is touched.
 */
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = "scripts/test-outcome-inventory.ts";
const COVERAGE = "scripts/test-outcome-coverage.ts";
const EGRESS = "scripts/test-proof-egress-inventory.ts";
const EMBED = "scripts/test-embed-proof.ts";

/**
 * Each entry: the assertion it defends, the file it breaks, the exact substitution, and the test
 * that must go red. `find` must appear exactly once, so a mutation cannot silently no-op.
 */
const MUTATIONS = [
  // ── catalog ────────────────────────────────────────────────────────────────────────────────
  { id: "T1-delete-a-catalog-row", test: INVENTORY, alsoRun: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  { action: "clarify", reason: "source_switch", stores: ["query_log"] },\n`,
    replace: "",
    breaks: "T1 exhaustiveness and the used-by-a-site assertion" },
  { id: "T1-add-an-unused-reason", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  { action: "clarify", reason: "source_switch", stores: ["query_log"] },`,
    replace: `  { action: "clarify", reason: "source_switch", stores: ["query_log"] },\n  { action: "clarify", reason: "never_produced_anywhere", stores: ["query_log"] },`,
    breaks: "T1 every reason is used by at least one site" },
  { id: "T1-duplicate-a-reason", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  { action: "decline_data", reason: "all_values_null", stores: ["query_log"] },`,
    replace: `  { action: "decline_data", reason: "all_values_null", stores: ["query_log"] },\n  { action: "decline_data", reason: "all_values_null", stores: ["query_log"] },`,
    breaks: "T1 every reason appears exactly once" },
  { id: "T1-give-answer_limited_scope-a-row", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  // ── clarify (4) ───────────────────────────────────────────────────────────────────────────`,
    replace: `  { action: "answer_limited_scope", reason: "invented_scope_reason", stores: ["query_log"] },\n  // ── clarify (4) ───────────────────────────────────────────────────────────────────────────`,
    breaks: "T1 the reserved action must have no catalog row" },
  { id: "T1b-reclassification-removed", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  { action: "decline_source_health", reason: "required_component_unavailable", stores: ["query_log"] },`,
    replace: `  { action: "decline_capability", reason: "required_component_unavailable", stores: ["query_log"] },`,
    breaks: "T1b the two reclassified sites map to decline_source_health" },
  { id: "T1c-second-store-membership-list", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `export const OUTCOME_STORES: readonly OutcomeStore[] = ["query_log", "shared_charts"] as const;`,
    replace: `export const OUTCOME_STORES: readonly OutcomeStore[] = ["query_log", "shared_charts"] as const;\n\nexport const REASONS_BY_STORE = { query_log: ["deterministic_plan"], shared_charts: ["stored_artifact_replay"] };`,
    breaks: "T1c there is no second store-membership list" },
  { id: "T2-rename-one-side-of-the-overlap", test: COVERAGE,
    file: "lib/proof-contract.ts",
    find: `  { action: "decline_data", reason: "outside_source_years", stores: ["query_log"] },       // ∗`,
    replace: `  { action: "decline_data", reason: "outside_the_source_years", stores: ["query_log"] },   // ∗`,
    breaks: "T2 the shared strings must stay identical" },

  // ── gate and projector ─────────────────────────────────────────────────────────────────────
  { id: "T3-outcome-mode-stamps-proof_schema_version", test: COVERAGE,
    file: "lib/proof-finalize.ts",
    find: `  return { record_kind: "decision", delivery_action: action, reason_code: reason };`,
    replace: `  return { record_kind: "decision", delivery_action: action, reason_code: reason,
    proof_schema_version: PROOF_SCHEMA_VERSION } as unknown as OutcomeLogFields;`,
    breaks: "T3 the outcome projector owns exactly three columns" },
  { id: "T4-projector-throws-instead-of-degrading", test: COVERAGE,
    file: "lib/proof-finalize.ts",
    find: `    return { record_kind: "decision", delivery_action: null, reason_code: null };`,
    replace: `    throw new Error("inadmissible outcome pair");`,
    breaks: "T4 an escaped value must degrade, never destroy the log row" },
  { id: "T7e-positional-two-argument-projector", test: COVERAGE,
    file: "lib/proof-finalize.ts",
    find: `export function outcomeLogFields(
  record: OutcomeLogRecord | null,`,
    replace: `export function outcomeLogFields(
  record: any,`,
    breaks: "T7e the projector accepts only the discriminated record" },
  { id: "T7f-inert-path-drops-the-reason", test: COVERAGE,
    file: "lib/proof-finalize.ts",
    find: `      action: outcome.action,
      reason: outcome.reason,
      requested: null,`,
    replace: `      action: outcome.action,
      reason: "deterministic_plan",
      requested: null,`,
    breaks: "T7f the reason must survive off mode and the degraded path" },
  { id: "T11-kill-switch-gated-on-proof-only", test: COVERAGE,
    file: "lib/proof-modes.ts",
    find: `export function outcomeLoggingEnabled(env: ModeEnv = process.env): boolean {
  if (parseKillSwitch(env[ENV_KILL_SWITCH])) return false;`,
    replace: `export function outcomeLoggingEnabled(env: ModeEnv = process.env): boolean {
  if (false) return false;`,
    breaks: "T11 the kill switch must disengage outcome logging too" },

  // ── structural, AST ────────────────────────────────────────────────────────────────────────
  { id: "T7a-unwrap-one-emitFactualPayload", test: INVENTORY,
    file: "app/api/hc-query/route.ts",
    find: `emitFactualPayload(switchProof, {`,
    replace: `((_p: unknown, v: unknown) => v)(switchProof, {`,
    breaks: "T7a decisions == sealed exits" },
  { id: "T7b-split-a-site-into-parallel-ternaries", test: INVENTORY,
    file: "app/api/embed/route.ts",
    find: `      outcome: rows.length > 0 ? OUTCOMES.stored_artifact_replay : OUTCOMES.no_rows_in_source,`,
    replace: `      outcome: { action: rows.length > 0 ? "answer" : "decline_data", reason: rows.length > 0 ? "stored_artifact_replay" : "no_rows_in_source" } as never,`,
    breaks: "T7b computed sites select between whole Outcome constants" },
  { id: "T7c-i-operational-site-supplies-an-outcome", test: INVENTORY,
    file: "app/api/hc-query/route.ts",
    find: `writeLog(question, sql, 0, \`DB: \${msg}\`, Date.now() - start, null, "hate_crime", [], "haiku-4.5", sessionId, null, OPERATIONAL_RECORD);`,
    replace: `writeLog(question, sql, 0, \`DB: \${msg}\`, Date.now() - start, null, "hate_crime", [], "haiku-4.5", sessionId, null, finalizeExit({ outcome: OUTCOMES.capability_path_unavailable }));`,
    breaks: "T7c-i the operational sites are exactly the declared 19 and none supplies an outcome" },
  { id: "T7c-ii-termination-predicate-requires-a-return", test: INVENTORY,
    file: "scripts/lib/exit-inventory.js",
    find: `        walk(t.finallyBlock, (n) => { if (calleeName(n, ts) === "close") closes = true; }, ts);`,
    replace: `        walk(t.finallyBlock, () => { /* a `+"`return`"+`-only termination predicate */ }, ts);`,
    breaks: "T7c-ii SSE stream closure counts as termination — this is the predicate that must " +
            "fail on the SSE outer catch" },
  { id: "T7d-embed-restores-hypotheticalAction", test: INVENTORY, alsoRun: EGRESS,
    file: "app/api/embed/route.ts",
    find: `          .run(finalization.decision.action, finalization.decision.reason, Date.now(), id);`,
    replace: `          .run(finalization.hypotheticalAction, finalization.decision.reason, Date.now(), id);`,
    breaks: "T7d the served action is stored, never the hypothetical one" },
  { id: "T7d-embed-writes-the-action-without-the-reason", test: INVENTORY, alsoRun: EGRESS,
    file: "app/api/embed/route.ts",
    find: `            "UPDATE shared_charts SET last_read_delivery_action = ?, last_read_reason_code = ?, last_read_at = ? WHERE id = ?",`,
    replace: `            "UPDATE shared_charts SET last_read_delivery_action = ?, last_read_at = ? WHERE id = ?",`,
    breaks: "T7d action and reason are written in one statement" },
  { id: "T7g-serialize-decision-into-the-envelope", test: INVENTORY,
    file: "lib/proof-finalize.ts",
    find: `    // What the contract WOULD have required. See ProofFinalization.hypotheticalAction.
    hypotheticalAction: finalization.hypotheticalAction,`,
    replace: `    decision: finalization.decision,
    hypotheticalAction: finalization.hypotheticalAction,`,
    breaks: "T7g no proof-owned shape gained a field without a version bump" },

  // ── round-1 review corrections: the two false acceptances must now bite ────────────────────
  { id: "R1-shr-direct-logger-drops-the-outcome-projector", test: INVENTORY,
    file: "app/api/shr-query/route.ts",
    find: `proofLogFields(decisionFinalization(switchProof)), outcomeLogFields(asOutcomeRecord(switchProof))`,
    replace: `proofLogFields(switchProof)`,
    breaks: "T7a-pairing: this exit bypasses the closure, so dropping the outcome projector " +
            "leaves its decision row unclassified after activation" },
  { id: "R1-hc-direct-logger-drops-the-outcome-projector", test: INVENTORY,
    file: "app/api/hc-query/route.ts",
    find: `proofLogFields(decisionFinalization(switchProof)), outcomeLogFields(asOutcomeRecord(switchProof))`,
    replace: `proofLogFields(switchProof)`,
    breaks: "T7a-pairing: the hate-crime counterpart of the same bypass" },
  { id: "R1-route-closure-stops-projecting-the-outcome", test: INVENTORY,
    file: "app/api/nibrs-query/route.ts",
    find: `proofLogFields(decisionFinalization(proof)), outcomeLogFields(asOutcomeRecord(proof))`,
    replace: `proofLogFields(decisionFinalization(proof))`,
    breaks: "T7a-pairing: a closure that stops projecting the outcome unclassifies every exit " +
            "that logs through it" },
  { id: "R1-embed-gate-reverts-to-proof-observation", test: EMBED,
    file: "app/api/embed/route.ts",
    find: `    if (withProof && outcomeWritesEnabled(process.env, finalization.mode)) {`,
    replace: `    if (withProof && isObserving(finalization.mode)) {`,
    breaks: "the embed activation matrix: OUTCOME_LOG=on with proof off is the intended P2.4 " +
            "state and must write; gating on proof observation makes the path inert" },
  { id: "R1-embed-gate-ignores-the-schema-probe", test: EMBED,
    file: "app/api/embed/route.ts",
    find: `    if (withProof && outcomeWritesEnabled(process.env, finalization.mode)) {`,
    replace: `    if (outcomeWritesEnabled(process.env, finalization.mode)) {`,
    breaks: "the complete-schema probe: an unmigrated shared_charts must not be written at all" },

  // ── round-2 review correction: the closure must project both from the SAME carrier ────────
  //
  // The round-1 pairing check proved a closure contained both wrapper chains. It did not prove
  // they received the same thing, so a closure could project proof from the delivered
  // finalization and the outcome from `null` while every exit using it stayed classified as
  // correctly paired. These mutations keep both wrappers present and change only what they
  // receive, which is exactly the shape a two-boolean check cannot see. Both compile, so the
  // test -- not the type checker -- is what has to catch them.
  { id: "R2-closure-outcome-carrier-is-null", test: INVENTORY,
    file: "app/api/query/route.ts",
    find: `outcomeLogFields(asOutcomeRecord(proof))`,
    replace: `outcomeLogFields(asOutcomeRecord(null))`,
    breaks: "T7a-pairing: the outcome projection no longer comes from the closure's carrier, so " +
            "every exit logging through it would write an all-NULL outcome" },
  { id: "R2-closure-proof-carrier-is-null", test: INVENTORY,
    file: "app/api/shr-query/route.ts",
    find: `proofLogFields(decisionFinalization(proof))`,
    replace: `proofLogFields(decisionFinalization(null))`,
    breaks: "T7a-pairing is symmetric: the same-carrier proof must reject a detached proof " +
            "projection as well as a detached outcome projection" },

  // ── migration ──────────────────────────────────────────────────────────────────────────────
  { id: "T5-rollback-drops-a-column-before-the-index", test: COVERAGE,
    file: "scripts/migrate-query-log-proof.js",
    find: `      if (indexPresent) db.exec(\`DROP INDEX \${INDEX_NAME}\`);`,
    replace: `      /* the index is left in place, so DROP COLUMN fails */`,
    breaks: "T5 rollback must drop the index before the columns it references" },
  { id: "T6-remove-the-column-filter", test: COVERAGE,
    file: "lib/query-log-columns.ts",
    find: `    if (!present.has(column)) {`,
    replace: `    if (false) {`,
    breaks: "T6 deploy-order tolerance: the writer must drop columns the live table lacks" },
  { id: "T6-unregister-the-outcome-columns", test: COVERAGE,
    file: "lib/query-log-columns.ts",
    find: `  "record_kind",\n  "reason_code",\n`,
    replace: "",
    breaks: "the outcome columns must be registered as migrated columns" },
  { id: "T10-add-a-backfill", test: INVENTORY,
    file: "scripts/migrate-query-log-proof.js",
    find: `    const after = new Set(tableColumns(db, "`,
    replace: `    db.exec("UPDATE query_log SET record_kind = 'decision' WHERE record_kind IS NULL");\n    const after = new Set(tableColumns(db, "`,
    breaks: "T10 the migration executes zero UPDATE statements" },
  { id: "T10-declare-a-column-NOT-NULL", test: INVENTORY,
    file: "scripts/migrate-query-log-proof.js",
    find: `  { name: "record_kind", type: "TEXT" },`,
    replace: `  { name: "record_kind", type: "TEXT NOT NULL DEFAULT 'decision'" },`,
    breaks: "T10 old rows keep NULL forever" },
];

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runTest(rel) {
  // node + tsx's own CLI entry rather than `npx`: on Windows `npx.cmd` is a shell script, and
  // execFileSync cannot spawn it, which made every control run look red for the wrong reason.
  try {
    execFileSync(process.execPath, [TSX_CLI, rel], { cwd: ROOT, stdio: "pipe" });
    return { failed: false };
  } catch (error) {
    return { failed: true, output: String(error.stdout || "") + String(error.stderr || "") };
  }
}

function main() {
  const targets = Array.from(new Set(MUTATIONS.map((m) => m.file)));
  const before = Object.fromEntries(targets.map((f) => [f, sha(path.join(ROOT, f))]));

  console.log("outcome mutation gates");
  console.log("  control: the unmutated suites must be green before any mutation means anything");
  for (const rel of [INVENTORY, COVERAGE, EGRESS]) {
    const control = runTest(rel);
    if (control.failed) {
      console.error(`  FAIL  control run of ${rel} is already red`);
      console.error(control.output.slice(-3000));
      process.exitCode = 1;
      return;
    }
    console.log(`  ok    control ${rel}`);
  }

  let caught = 0;
  for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    const original = fs.readFileSync(abs, "utf8");
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      console.error(`  FAIL  ${m.id}: its anchor appears ${occurrences} times in ${m.file}; a ` +
                    `mutation that cannot be placed exactly once proves nothing`);
      process.exitCode = 1;
      continue;
    }
    try {
      fs.writeFileSync(abs, original.replace(m.find, m.replace), "utf8");
      const suites = [m.test].concat(m.alsoRun ? [m.alsoRun] : []);
      const results = suites.map((s) => ({ suite: s, ...runTest(s) }));
      const red = results.filter((r) => r.failed).map((r) => r.suite);
      if (red.length === 0) {
        console.error(`  FAIL  ${m.id}: the suite stayed GREEN. Breaks: ${m.breaks}`);
        process.exitCode = 1;
      } else {
        caught++;
        console.log(`  ok    ${m.id}  → red in ${red.map((r) => path.basename(r)).join(", ")}`);
      }
    } finally {
      fs.writeFileSync(abs, original, "utf8");
    }
  }

  for (const f of targets) {
    const now = sha(path.join(ROOT, f));
    if (now !== before[f]) {
      console.error(`  FAIL  ${f} was not restored to its original bytes`);
      process.exitCode = 1;
    }
  }

  console.log(`\n${caught}/${MUTATIONS.length} mutations caught; every target restored`);
  if (caught !== MUTATIONS.length) process.exitCode = 1;
}

main();
