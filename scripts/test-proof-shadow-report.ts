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
import { PROOF_CHECKS, CHECK_STATES, PROOF_MANIFEST_VERSION, DELIVERY_ACTIONS } from "../lib/proof-contract";

// eslint-disable-next-line @typescript-eslint/no-require-imports
/** One bucket's counts. Shared by the overall figures and by every tab/family bucket. */
type Tally = {
  rows: number;
  withProof: number;
  /** Rows carrying a manifest with checks -- the only valid denominator for a rate. */
  evaluated: number;
  envelopeMissing: number;
  unparseable: number;
  reduced: number;
  envelopeError: number;
  malformed: number;
  incompatibleVersion: number;
  delivered: Record<string, number>;
  wouldHave: Record<string, number>;
  checks: Record<string, number>;
  blockedByCheck: Record<string, number>;
};

const report = require("./lib/proof-shadow-report.js") as {
  PROOF_COLUMNS: string[];
  selectClause: (columns: Set<string>) => string;
  buildProofShadowReport: (queries: unknown[], isHuman: (q: unknown) => boolean) => {
    overall: Tally;
    byTab: Map<string, Tally>;
    byFamily: Map<string, Tally>;
  };
  DECLARED_CHECKS: string[];
  VALID_CHECK_STATES: Set<string>;
  MANIFEST_VERSION: number;
  DECLARED_ACTIONS: Set<string>;
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

/**
 * A COMPLETE v1 check map, with the named checks overridden.
 *
 * Every declared check must be present with a valid state for an envelope to be gradable,
 * so a fixture that lists two checks is not a realistic envelope -- it is a malformed one.
 * Unnamed checks default to `not_applicable`, which is excluded from the graded
 * denominator and therefore does not disturb the pass/fail/unknown counts asserted below.
 */
function fullChecks(overrides: Record<string, string> = {}): Record<string, string> {
  const checks: Record<string, string> = {};
  for (const name of PROOF_CHECKS) checks[name] = "not_applicable";
  return { ...checks, ...overrides };
}

function envelope(hypothetical: string, checks: Record<string, string> = {}, blocking: string[] = []) {
  return JSON.stringify({ manifest: { v: PROOF_MANIFEST_VERSION, checks: fullChecks(checks) }, blocker: blocking.length ? "blocked" : null, blockingChecks: blocking, hypotheticalAction: hypothetical });
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

console.log("\ncheck states are attributable to a tab and a family");
{
  /** Text of the table row whose first cell is `label`, tags stripped. */
  function rowText(html: string, label: string): string {
    for (const row of html.split("<tr>")) {
      const cells = row.split("<td>").slice(1).map((cell) => cell.split("</td>")[0]);
      if (cells.length && cells[0].replace(/<[^>]*>/g, "").trim() === label) {
        return row.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    return "";
  }

  // Codex's trigger for this blocker: one passing row on one tab/family, one failing row
  // on another. The overall line shows 1 passed / 1 failed either way; the deliverable is
  // being able to say WHICH tab and WHICH family failed.
  const mixed = [
    shadowRow({ tab: "current", plan_family: "family-a", proof_manifest: envelope("answer", { metric: "passed" }) }),
    shadowRow({ tab: "nibrs", plan_family: "family-b", proof_manifest: envelope("decline_capability", { metric: "failed" }, ["metric"]) }),
  ];
  const built = report.buildProofShadowReport(mixed, ALL_HUMAN);
  const html = report.renderProofShadowSection(built);

  check("the tab tally carries per-tab check states", () => {
    assert.strictEqual(built.byTab.get("current")!.checks.passed, 1);
    assert.strictEqual(built.byTab.get("current")!.checks.failed, 0);
    assert.strictEqual(built.byTab.get("nibrs")!.checks.failed, 1);
    assert.strictEqual(built.byTab.get("nibrs")!.checks.passed, 0);
  });

  check("the family tally carries per-family check states", () => {
    assert.strictEqual(built.byFamily.get("family-a")!.checks.passed, 1);
    assert.strictEqual(built.byFamily.get("family-b")!.checks.failed, 1);
  });

  check("the email names which tab failed", () => {
    assert.match(rowText(html, "current"), /passed 1/, `current row was: ${rowText(html, "current")}`);
    assert.doesNotMatch(rowText(html, "current"), /failed 1/, "current must not inherit nibrs's failure");
    assert.match(rowText(html, "nibrs"), /failed 1/, `nibrs row was: ${rowText(html, "nibrs")}`);
  });

  check("the email names which family failed", () => {
    assert.match(rowText(html, "family-a"), /passed 1/);
    assert.match(rowText(html, "family-b"), /failed 1/);
    assert.doesNotMatch(rowText(html, "family-a"), /failed 1/);
  });
}

console.log("\nnot every row with a proof record was evaluated");
{
  const reducedEnvelope = JSON.stringify({ v: 1, envelopeReduced: true, blockingChecks: [], hypotheticalAction: "answer" });
  const rows = [
    shadowRow({ tab: "current", proof_manifest: envelope("answer", { metric: "passed" }) }),
    shadowRow({ tab: "current", proof_manifest: null }),            // observed, wrote no envelope
    shadowRow({ tab: "current", proof_manifest: "{not json" }),     // envelope corrupted
    shadowRow({ tab: "current", proof_manifest: reducedEnvelope }), // envelope shed its manifest
  ];
  const built = report.buildProofShadowReport(rows, ALL_HUMAN);

  check("evaluated counts only records that carry a manifest", () => {
    // Without this, a reduced or missing envelope reads as "evaluated, nothing to
    // report" -- the D6 failure shape, one layer in.
    assert.strictEqual(built.overall.evaluated, 1, "only one row actually carried checks");
    assert.strictEqual(built.overall.withProof, 4, "all four were observed, though");
  });

  check("missing, unreadable, and reduced envelopes are counted apart", () => {
    assert.strictEqual(built.overall.envelopeMissing, 1);
    assert.strictEqual(built.overall.unparseable, 1);
    assert.strictEqual(built.overall.reduced, 1);
  });

  check("a parseable envelope with no manifest checks is malformed, not evaluated", () => {
    // Neither of the two DECLARED fallback shapes, so nothing flags it -- yet there is no
    // manifest to grade. `evaluated` is defined as "rows that carried a manifest with
    // checks in it", and crediting these contradicts that definition while adding a
    // phantom "unrecorded" hypothetical action drawn from a structurally empty record.
    for (const shape of ["{}", '{"v":1}', '{"manifest":{}}', '{"manifest":null}']) {
      const built = report.buildProofShadowReport(
        [shadowRow({ tab: "current", proof_manifest: shape })],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.malformed, 1, `${shape} must count as malformed`);
      assert.strictEqual(built.overall.evaluated, 0, `${shape} has nothing to grade`);
      assert.deepStrictEqual(built.overall.wouldHave, {}, `${shape} must not invent an action`);
      assert.match(
        report.renderProofShadowSection(built),
        /malformed/,
        `${shape} must be visible to the reader, not silently dropped`,
      );
    }
  });

  check("a check map that is not a complete v1 map is malformed", () => {
    // typeof [] === "object" in JavaScript, so an array slipped through a plain typeof
    // guard; and an empty or partial map contributes zero check states while counting as
    // evaluated -- the same false-clean D6 shape the categories above exist to prevent.
    const shapes: Record<string, unknown> = {
      "an array": [],
      "an empty object": {},
      "a partial map": { semanticPlan: "passed" },
      "a map missing one mandatory check": (() => {
        const partial: Record<string, string> = {};
        for (const name of PROOF_CHECKS.slice(1)) partial[name] = "passed";
        return partial;
      })(),
      "an unrecognized check state": (() => {
        const bad: Record<string, string> = {};
        for (const name of PROOF_CHECKS) bad[name] = "passed";
        bad[PROOF_CHECKS[0]] = "probably";
        return bad;
      })(),
    };
    for (const [label, checks] of Object.entries(shapes)) {
      const built = report.buildProofShadowReport(
        [shadowRow({
          tab: "current",
          proof_manifest: JSON.stringify({ v: 1, hypotheticalAction: "answer", manifest: { checks } }),
        })],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.malformed, 1, `${label} must count as malformed`);
      assert.strictEqual(built.overall.evaluated, 0, `${label} must not count as evaluated`);
      assert.deepStrictEqual(built.overall.wouldHave, {}, `${label} must not credit a hypothetical action`);
      assert.strictEqual(built.overall.checks.passed, 0, `${label} must contribute no check states`);
    }
  });

  check("a complete v1 check map IS gradable", () => {
    // The counterpart to the above: the validation must not reject a real envelope.
    const built = report.buildProofShadowReport(
      [shadowRow({ tab: "current", proof_manifest: envelope("answer", { metric: "passed" }) })],
      ALL_HUMAN,
    );
    assert.strictEqual(built.overall.evaluated, 1);
    assert.strictEqual(built.overall.malformed, 0);
    assert.strictEqual(built.overall.checks.passed, 1);
  });

  check("an unversioned or incompatible envelope is never read with v1 semantics", () => {
    // A complete v1 check map is not enough: without a version, or under a different one,
    // these numbers would be v1 semantics applied to a schema that never agreed to them.
    const completeMap = fullChecks({ metric: "passed" });
    const cases: [string, unknown, "malformed" | "incompatibleVersion"][] = [
      // Missing version is a writer defect -- no declared shape omits it.
      ["a full envelope with no manifest.v", { hypotheticalAction: "answer", manifest: { checks: completeMap } }, "malformed"],
      ["a reduced envelope with no v", { envelopeReduced: true, hypotheticalAction: "answer" }, "malformed"],
      ["an error envelope with no v", { envelopeError: true }, "malformed"],
      // A present but different version is expected skew during a rolling deploy, not a defect.
      ["a full envelope at v2", { hypotheticalAction: "answer", manifest: { v: 2, checks: completeMap } }, "incompatibleVersion"],
      ["a reduced envelope at v2", { v: 2, envelopeReduced: true, hypotheticalAction: "answer" }, "incompatibleVersion"],
      ["an error envelope at v2", { v: 2, envelopeError: true }, "incompatibleVersion"],
    ];
    for (const [label, shape, expected] of cases) {
      const built = report.buildProofShadowReport(
        [shadowRow({ tab: "current", proof_manifest: JSON.stringify(shape) })],
        ALL_HUMAN,
      );
      const tally = built.overall as unknown as Record<string, number>;
      assert.strictEqual(tally[expected], 1, `${label} must count as ${expected}`);
      assert.strictEqual(built.overall.evaluated, 0, `${label} must not be evaluated`);
      assert.strictEqual(built.overall.reduced, 0, `${label} must not be classified as reduced`);
      assert.strictEqual(built.overall.envelopeError, 0, `${label} must not be classified as a build failure`);
      assert.deepStrictEqual(built.overall.wouldHave, {}, `${label} must not credit a hypothetical action`);
      assert.match(report.renderProofShadowSection(built), /schema|malformed/, `${label} must be visible`);
    }
  });

  check("the reporter's declared checks, states, and version have not drifted", () => {
    // scripts/lib/proof-shadow-report.js is CommonJS with no build step, so it cannot
    // import lib/proof-contract.ts and has to restate the list. This is the guard that
    // makes the duplication safe: adding a proof check without updating the reporter
    // fails here rather than silently letting a stale map be graded as complete.
    assert.deepStrictEqual(report.DECLARED_CHECKS, [...PROOF_CHECKS]);
    assert.deepStrictEqual([...report.VALID_CHECK_STATES].sort(), [...CHECK_STATES].sort());
    assert.strictEqual(report.MANIFEST_VERSION, PROOF_MANIFEST_VERSION);
    assert.deepStrictEqual([...report.DECLARED_ACTIONS].sort(), [...DELIVERY_ACTIONS].sort());
  });

  check("an envelope the serializer could not build is ungradable, not evaluated", () => {
    // serializeProofEnvelope's last resort is { v, envelopeError: true } -- deliberately
    // recorded rather than stored as null so the failure stays visible. It carries no
    // manifest and no hypotheticalAction, so counting it as evaluated would make an
    // envelope with nothing recoverable in it look like a clean graded record.
    const errored = report.buildProofShadowReport(
      [shadowRow({ tab: "current", proof_manifest: JSON.stringify({ v: 1, envelopeError: true }) })],
      ALL_HUMAN,
    );
    assert.strictEqual(errored.overall.envelopeError, 1);
    assert.strictEqual(errored.overall.evaluated, 0, "there is nothing in it to grade");
    assert.deepStrictEqual(
      errored.overall.wouldHave,
      {},
      "and it must not invent an 'unrecorded' hypothetical action either",
    );
  });

  check("a bucket with nothing evaluated shows no rate", () => {
    const none = report.buildProofShadowReport(
      [shadowRow({ tab: "shr", proof_manifest: null })],
      ALL_HUMAN,
    );
    assert.strictEqual(none.overall.evaluated, 0);
    const html = report.renderProofShadowSection(none);
    assert.doesNotMatch(html, /\d+(\.\d+)?%/, "a rate over zero evaluated records is meaningless");
  });
}

console.log("\nthe decoder is total: no proof row can throw");
{
  const completeMap = fullChecks({ metric: "passed" });
  const full = (over: Record<string, unknown>) => JSON.stringify({
    manifest: { v: PROOF_MANIFEST_VERSION, checks: completeMap },
    hypotheticalAction: "answer",
    blockingChecks: [],
    ...over,
  });

  check("a non-array blockingChecks is malformed rather than thrown or iterated", () => {
    // `for (const x of {})` THROWS, and a string iterates per character -- blockingChecks:
    // "metric" produced six blockers named m, e, t, r, i and c.
    for (const hostile of [{}, "metric", 7, true, null]) {
      let built: ReturnType<typeof report.buildProofShadowReport> | null = null;
      assert.doesNotThrow(() => {
        built = report.buildProofShadowReport(
          [shadowRow({ proof_manifest: full({ blockingChecks: hostile }) })],
          ALL_HUMAN,
        );
      }, `blockingChecks ${JSON.stringify(hostile)} must not throw`);
      assert.strictEqual(built!.overall.malformed, 1, `${JSON.stringify(hostile)} must be malformed`);
      assert.strictEqual(built!.overall.evaluated, 0);
      assert.deepStrictEqual(built!.overall.blockedByCheck, {}, "no blocker may be invented");
    }
  });

  check("blockingChecks entries must be declared check names, and repeats count once", () => {
    const unknown = report.buildProofShadowReport(
      [shadowRow({ proof_manifest: full({ blockingChecks: ["notARealCheck"] }) })],
      ALL_HUMAN,
    );
    assert.strictEqual(unknown.overall.malformed, 1, "an undeclared blocker name is malformed");
    assert.deepStrictEqual(unknown.overall.blockedByCheck, {});

    const dupes = report.buildProofShadowReport(
      [shadowRow({ proof_manifest: full({ blockingChecks: ["metric", "metric"] }) })],
      ALL_HUMAN,
    );
    assert.strictEqual(dupes.overall.evaluated, 1);
    assert.strictEqual(dupes.overall.blockedByCheck.metric, 1, "a repeated blocker counts once");
  });

  check("a hypotheticalAction that is not a declared action credits nothing", () => {
    for (const action of [undefined, null, "", "probably", 7, {}]) {
      const built = report.buildProofShadowReport(
        [shadowRow({ proof_manifest: full({ hypotheticalAction: action }) })],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.malformed, 1, `action ${JSON.stringify(action)} must be malformed`);
      assert.deepStrictEqual(built.overall.wouldHave, {}, "and must not invent an action bucket");
      assert.strictEqual(built.overall.evaluated, 0);
    }
  });

  check("a reduced envelope needs a declared action and a valid blocker list too", () => {
    for (const over of [{ hypotheticalAction: "probably" }, { blockingChecks: {} }, { hypotheticalAction: undefined }]) {
      const built = report.buildProofShadowReport(
        [shadowRow({ proof_manifest: JSON.stringify({
          v: PROOF_MANIFEST_VERSION, envelopeReduced: true, hypotheticalAction: "answer", blockingChecks: [], ...over,
        }) })],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.reduced, 0, `${JSON.stringify(over)} is not a usable reduced envelope`);
      assert.strictEqual(built.overall.malformed, 1);
      assert.deepStrictEqual(built.overall.wouldHave, {});
    }
  });

  check("the fallback discriminants must be exactly true", () => {
    for (const over of [{ envelopeReduced: "yes" }, { envelopeError: 1 }, { envelopeReduced: true, envelopeError: true }]) {
      const built = report.buildProofShadowReport(
        [shadowRow({ proof_manifest: JSON.stringify({
          v: PROOF_MANIFEST_VERSION, hypotheticalAction: "answer", blockingChecks: [], ...over,
        }) })],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.reduced, 0, `${JSON.stringify(over)} must not read as reduced`);
      assert.strictEqual(built.overall.envelopeError, 0, `${JSON.stringify(over)} must not read as a build failure`);
      assert.strictEqual(built.overall.malformed, 1);
    }
  });

  check("one bad row cannot stop the section rendering, and the good rows still count", () => {
    // Contract invariant 15: the existing digest continues independently of the proof
    // pipeline. daily-query-analysis.js renders this section INLINE, so a throw here aborts
    // the whole email -- the failure mode this test exists to prevent.
    const rows = [
      shadowRow({ proof_manifest: full({ blockingChecks: {} }) }),
      shadowRow({ proof_manifest: "{not json" }),
      shadowRow({ proof_manifest: null }),
      shadowRow({ tab: "nibrs", proof_manifest: envelope("answer", { metric: "passed" }) }),
    ];
    let html = "";
    assert.doesNotThrow(() => {
      html = report.renderProofShadowSection(report.buildProofShadowReport(rows, ALL_HUMAN));
    });
    assert.ok(html.length > 0, "the section must still render");
    const built = report.buildProofShadowReport(rows, ALL_HUMAN);
    assert.strictEqual(built.overall.evaluated, 1, "the one good row is still graded");
    assert.strictEqual(built.byTab.get("nibrs")!.checks.passed, 1);
  });
}

console.log("\nonly a recognized observing mode counts as coverage");
{
  check("an unrecognized or off proof_mode is not observation", () => {
    for (const mode of ["off", "garbage", "", null, 1, true]) {
      const built = report.buildProofShadowReport(
        [{ tab: "current", proof_mode: mode, delivery_action: "answer", plan_family: null, proof_manifest: null }],
        ALL_HUMAN,
      );
      assert.strictEqual(built.overall.withProof, 0, `proof_mode ${JSON.stringify(mode)} is not observing`);
      assert.strictEqual(
        report.shadowHealth(built).state,
        "not_observing",
        `proof_mode ${JSON.stringify(mode)} must never report complete observation`,
      );
    }
  });

  check("shadow and enforce both count as observing", () => {
    for (const mode of ["shadow", "enforce"]) {
      const built = report.buildProofShadowReport([shadowRow({ proof_mode: mode })], ALL_HUMAN);
      assert.strictEqual(built.overall.withProof, 1, `${mode} is an observing mode`);
    }
  });
}

console.log("\nreduced envelopes still contribute their blockers");
{
  check("a reduced envelope's blockingChecks are tallied", () => {
    // The serializer preserves blockingChecks specifically BECAUSE they are the most
    // diagnostic field. Returning before tallying them undercounted every oversized record
    // in "What blocked delivery most often".
    const built = report.buildProofShadowReport(
      [shadowRow({ proof_manifest: JSON.stringify({
        v: PROOF_MANIFEST_VERSION, envelopeReduced: true, hypotheticalAction: "decline_capability",
        blockingChecks: ["semanticPlan", "metric"],
      }) })],
      ALL_HUMAN,
    );
    assert.strictEqual(built.overall.reduced, 1);
    assert.strictEqual(built.overall.blockedByCheck.semanticPlan, 1);
    assert.strictEqual(built.overall.blockedByCheck.metric, 1);
    assert.strictEqual(built.overall.evaluated, 0, "still not gradable, though");
  });
}

console.log(`\nproof shadow report tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof shadow report tests: FAILED");
} else {
  console.log("proof shadow report tests: passed");
}
