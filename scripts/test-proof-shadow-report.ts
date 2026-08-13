/**
 * Digest reporting for the shadow period (handoff §9.1 Stage 1, §14.1).
 *
 * The property that matters most here is NOT the arithmetic. It is that the section
 * cannot present an absent shadow period as a healthy one. A pass rate computed over
 * whichever rows happen to carry a proof record is meaningless if most rows carry
 * none, and "0 problems found" over 0 evaluated rows is the exact failure that let
 * detector D6 report clean for weeks against a 0-byte reference database.
 *
 * Second: what was DELIVERED and what the contract would have PERMITTED are separate
 * lines. In shadow the first is `answer` for essentially every row. Collapsing them
 * would make the shadow period read as a success and would be the single most
 * misleading number this project could print.
 */
import assert from "node:assert";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const report = require("./lib/proof-shadow-report.js") as {
  PROOF_COLUMNS: string[];
  selectClause: (columns: Set<string>) => string;
  buildProofShadowReport: (queries: unknown[], isHuman: (q: unknown) => boolean) => {
    overall: { rows: number; withProof: number; delivered: Record<string, number>; wouldHave: Record<string, number>; checks: Record<string, number>; blockedByCheck: Record<string, number>; unparseable: number };
    byTab: Map<string, { rows: number; withProof: number }>;
    byFamily: Map<string, { rows: number; withProof: number }>;
  };
  shadowHealth: (r: unknown) => { state: string; note: string };
  renderProofShadowSection: (r: unknown) => string;
};

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const ALL_HUMAN = () => true;

function envelope(hypothetical: string, checks: Record<string, string> = {}, blocking: string[] = []) {
  return JSON.stringify({ manifest: { checks }, blocker: blocking.length ? "blocked" : null, blockingChecks: blocking, hypotheticalAction: hypothetical });
}

/** A shadow-era row: delivered an answer, proof blocked. */
function shadowRow(over: Record<string, unknown> = {}) {
  return {
    tab: "current",
    proof_mode: "shadow",
    delivery_action: "answer",
    plan_family: null,
    proof_manifest: envelope("decline_capability", { semanticPlan: "unknown", metric: "passed" }, ["semanticPlan"]),
    ...over,
  };
}

console.log("\nan absent shadow period is never reported as a clean one");
{
  check("no traffic renders nothing at all", () => {
    const built = report.buildProofShadowReport([], ALL_HUMAN);
    assert.strictEqual(report.shadowHealth(built).state, "no_traffic");
    assert.strictEqual(report.renderProofShadowSection(built), "", "an empty window must not grow a section");
  });

  check("traffic with NO proof records says so, and prints no rates", () => {
    // The off-mode / not-yet-deployed case. This is the one that must never look fine.
    const rows = Array.from({ length: 12 }, () => ({ tab: "current", proof_mode: null, delivery_action: null, plan_family: null, proof_manifest: null }));
    const built = report.buildProofShadowReport(rows, ALL_HUMAN);
    const health = report.shadowHealth(built);
    assert.strictEqual(health.state, "not_observing");
    assert.match(health.note, /not a clean result/);
    const html = report.renderProofShadowSection(built);
    assert.match(html, /none carries a proof record/);
    assert.doesNotMatch(html, /Individual checks/, "no rates may be shown when nothing was evaluated");
  });

  check("partial coverage is stated, not silently averaged over", () => {
    const rows = [shadowRow(), shadowRow(), { tab: "current", proof_mode: null, delivery_action: null, plan_family: null, proof_manifest: null }];
    const built = report.buildProofShadowReport(rows, ALL_HUMAN);
    const health = report.shadowHealth(built);
    assert.strictEqual(health.state, "partial");
    assert.match(health.note, /2 of 3/);
    assert.match(health.note, /only the evaluated subset/);
  });

  check("complete coverage says so explicitly", () => {
    const built = report.buildProofShadowReport([shadowRow(), shadowRow()], ALL_HUMAN);
    assert.strictEqual(report.shadowHealth(built).state, "complete");
  });
}

console.log("\ndelivered and would-have-delivered stay separate");
{
  const built = report.buildProofShadowReport([shadowRow(), shadowRow(), shadowRow()], ALL_HUMAN);

  check("the shadow reality is visible: delivered answers, blocked proofs", () => {
    assert.strictEqual(built.overall.delivered.answer, 3);
    assert.strictEqual(built.overall.wouldHave.decline_capability, 3);
  });

  check("the rendered section shows both lines and explains the gap", () => {
    const html = report.renderProofShadowSection(built);
    assert.match(html, /Actually delivered/);
    assert.match(html, /The contract would have/);
    assert.match(html, /Shadow mode changes nothing a user sees/);
  });

  check("actions are rendered in plain language", () => {
    const html = report.renderProofShadowSection(built);
    assert.match(html, /declined — no supported path/);
    assert.doesNotMatch(html, /decline_capability/, "raw enum values are not for a human reader");
  });

  check("'could not tell' is never counted as a pass", () => {
    assert.strictEqual(built.overall.checks.unknown, 3, "one unknown check per row");
    assert.strictEqual(built.overall.checks.passed, 3, "and one passed");
    const html = report.renderProofShadowSection(built);
    assert.match(html, /"Could not tell" is not a pass/);
  });

  check("the most common blocker is surfaced", () => {
    assert.strictEqual(built.overall.blockedByCheck.semanticPlan, 3);
    assert.match(report.renderProofShadowSection(built), /What blocked delivery most often/);
  });
}

console.log("\nbreakdowns by tab and plan family");
{
  const rows = [
    shadowRow({ tab: "current", plan_family: "current-agency-trend" }),
    shadowRow({ tab: "current", plan_family: "current-agency-trend" }),
    shadowRow({ tab: "nibrs", plan_family: "nibrs-clearance-type" }),
    shadowRow({ tab: "shr", plan_family: null }),
  ];
  const built = report.buildProofShadowReport(rows, ALL_HUMAN);

  check("tabs are counted separately", () => {
    assert.strictEqual(built.byTab.get("current")!.rows, 2);
    assert.strictEqual(built.byTab.get("nibrs")!.rows, 1);
    assert.strictEqual(built.byTab.get("shr")!.rows, 1);
  });

  check("families are counted separately", () => {
    assert.strictEqual(built.byFamily.get("current-agency-trend")!.rows, 2);
    assert.strictEqual(built.byFamily.get("nibrs-clearance-type")!.rows, 1);
  });

  check("a row with NO family is not bucketed into a family", () => {
    // Otherwise the report invents a family-shaped group out of rows the proof system
    // never classified, and a reader would read it as a real family's readiness.
    assert.strictEqual(built.byFamily.size, 2);
    for (const key of built.byFamily.keys()) {
      assert.ok(key !== "unknown" && key !== "none" && key !== "null", `unexpected family bucket: ${key}`);
    }
  });

  check("both tables render", () => {
    const html = report.renderProofShadowSection(built);
    assert.match(html, /<h3>Tab<\/h3>/);
    assert.match(html, /<h3>Plan family<\/h3>/);
    assert.match(html, /current-agency-trend/);
  });
}

console.log("\nthe digest's own traffic filter is respected");
{
  check("non-human rows are excluded from every tally", () => {
    // Passed in rather than duplicated, so this section counts exactly what the rest of
    // the email counts. A separate copy would drift and the numbers would disagree.
    const rows = [shadowRow({ session_id: "INTERNAL_SESSION" }), shadowRow()];
    const isHuman = (q: unknown) => (q as { session_id?: string }).session_id !== "INTERNAL_SESSION";
    const built = report.buildProofShadowReport(rows, isHuman);
    assert.strictEqual(built.overall.rows, 1);
  });
}

console.log("\nmalformed records are surfaced, not skipped");
{
  check("an unparseable envelope is counted and called a defect", () => {
    const built = report.buildProofShadowReport([shadowRow({ proof_manifest: "{not json" })], ALL_HUMAN);
    assert.strictEqual(built.overall.unparseable, 1);
    const html = report.renderProofShadowSection(built);
    assert.match(html, /could not be read/);
    assert.match(html, /it should be zero/);
  });
}

console.log("\nthe SELECT clause degrades on an unmigrated database");
{
  check("missing columns become NULL rather than a failed query", () => {
    const clause = report.selectClause(new Set(["id", "tab"]));
    for (const column of report.PROOF_COLUMNS) {
      assert.match(clause, new RegExp(`NULL AS ${column}`), `${column} must degrade to NULL`);
    }
  });

  check("present columns are selected directly", () => {
    const clause = report.selectClause(new Set(report.PROOF_COLUMNS));
    assert.doesNotMatch(clause, /NULL AS/);
    for (const column of report.PROOF_COLUMNS) assert.match(clause, new RegExp(`\\b${column}\\b`));
  });
}

console.log(`\nproof shadow report tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof shadow report tests: FAILED");
} else {
  console.log("proof shadow report tests: passed");
}
