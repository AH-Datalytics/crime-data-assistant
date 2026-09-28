/**
 * The evidence-to-answer boundary: a populated answer must survive, an unsupported zero must not.
 *
 * THE TWO MEASURED DEFECTS, both in `guardEmptyStateWording` (lib/result-state.ts).
 *
 * 1. OVER-FIRE. The guard decided from a regex over the narrative and never saw the rows. GC-073's
 *    follow-up returned 35 rows carrying 4,794 murders, and because `genericResultState` reports
 *    `unknown` for every ordinary successful result, one "zero" phrase caused the WHOLE narrative —
 *    figures, entities, period and the NIBRS coverage caveat — to be replaced by "I can't determine
 *    safely whether this is a genuine zero…". Observed in the 09-09 capture and in query-log row 231.
 * 2. UNDER-FIRE. `CLAIM_RULES` matched the word `zero` but not the numeral. On an EMPTY result
 *    "There were 0 murders in Ward, AR in 2024" was delivered.
 *
 * These are one location and TWO DISTINCT mechanisms; neither is claimed as the other's root cause.
 *
 * THE DRAFTS BELOW ARE CONSTRUCTED REPRODUCTIONS, clearly labelled. The capture stores only the
 * post-substitution text, so no pre-substitution model draft exists to quote. They demonstrate the
 * triggering mechanism against the capture's real rows; they are not a recovered record of the exact
 * phrase that triggered the measured swap.
 *
 * Local only: shipped source and the placed capture. No database, model, network, server or route
 * import with initialization side effects.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  guardEmptyStateWording,
  governFactualNarrative,
  isTrustedGuidanceSafe,
  classifyResultState,
} from "../lib/result-state";
import { genericResultState } from "../lib/result-state-adapters";
import { applyResultDisclosures } from "../lib/result-disclosure";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

const EMPTY_STATE_MESSAGE_FRAGMENT = /genuine zero, an unreported period, or a gap in coverage/i;
const CAVEAT = "Note: This data comes from the FBI's NIBRS program. Not all agencies report to this system, and some may have incomplete data.";

/* ── the capture's own rows ─────────────────────────────────────────── */
const turns = fs.readFileSync("audit/correctness-repeat-2026-09-09/run/turns.jsonl", "utf8").trim().split(/\r?\n/);
const gc073 = turns.map((l) => JSON.parse(l)).find((t) => t.turn.caseId === "GC-073" && t.turn.turnIndex === 1);
const GC073_ROWS = gc073.attempts[gc073.attempts.length - 1].parsed.rows as Record<string, unknown>[];
const GC073_SQL = gc073.attempts[gc073.attempts.length - 1].parsed.sql as string;

/* ── 1. GC-073 replay: the unsupported sentence goes, everything else stays ── */
console.log("1 - GC-073 saved rows, constructed draft");
{
  const state = genericResultState({ sql: GC073_SQL, rows: GC073_ROWS });
  check(state.state === "unknown" && state.establishedFromEvidence === false,
    `a populated successful result is still state=unknown (got ${state.state}/${state.establishedFromEvidence})`);

  // CONSTRUCTED draft: (a) supported figure/entity/period, (b) an unauthorized zero sentence,
  // (c) the applicable caveat.
  const draft = [
    "Murder clearance types for 35 cities in 2024. Baltimore, MD recorded 194 murders with 87 cleared by arrest.",
    "Several cities recorded zero prosecution-declined clearances.",
    CAVEAT,
  ].join(" ");

  const g = guardEmptyStateWording(draft, state, { hasFigures: GC073_ROWS.length > 0 });
  console.log(`  ${JSON.stringify(g.safeText.slice(0, 110))}`);
  check(!EMPTY_STATE_MESSAGE_FRAGMENT.test(g.safeText), "the empty-state message must not appear");
  check(/194 murders with 87 cleared by arrest/.test(g.safeText), "the supported figure must survive");
  check(/Baltimore, MD/.test(g.safeText), "the entity must survive");
  check(/2024/.test(g.safeText), "the period must survive");
  check(g.safeText.includes("FBI's NIBRS program"), "the applicable caveat must survive");
  check(!/zero prosecution-declined/.test(g.safeText), "the unsupported sentence must be gone");
  check(!/\bzero\b/i.test(g.safeText.replace(/omitted because[\s\S]*/i, "")),
    "no unverified zero claim may be restated in what remains");
  check(g.removed === true, "the result must report a removal");
  check(g.unsupportedClaim === "a true zero", `the reason must name the claim (got ${g.unsupportedClaim})`);
}

/* ── 2. mixed populated fixture: rows are not authority for a claim about another place ── */
console.log("");
console.log("2 - mixed fixture, and the one-row-null shape");
{
  const rows = [{ city: "Chicago", state: "IL", murders: 512 }];
  const state = genericResultState({ sql: "SELECT city, state, murders FROM t", rows });
  const draft = "Chicago, IL recorded 512 murders in 2024. Peoria, IL recorded zero murders in 2024.";
  const g = guardEmptyStateWording(draft, state, { hasFigures: true });
  check(/512 murders/.test(g.safeText), "the established figure survives");
  check(!/Peoria, IL recorded zero/.test(g.safeText), "an unsupported zero about ANOTHER place is removed");
  check(!EMPTY_STATE_MESSAGE_FRAGMENT.test(g.safeText), "no empty-state message on a populated result");

  // A single aggregate row whose value is null is not authority for "0".
  const nullRows = [{ city: "Ward", state: "AR", murders: null }];
  const nullState = genericResultState({ sql: "SELECT SUM(x) AS murders FROM t", rows: nullRows });
  const g2 = guardEmptyStateWording("Ward, AR recorded 0 murders in 2024.", nullState, { hasFigures: true });
  check(!/recorded 0 murders/.test(g2.safeText), "a one-row null result is not authority for a zero claim");

  // Ordinary populated text with no triggering claim is byte-identical at the seam.
  const plain = "Murder clearance types for 35 cities in 2024, by clearance category.";
  const g3 = guardEmptyStateWording(plain, state, { hasFigures: true });
  check(g3.safeText === plain, "untriggered populated text is unchanged");
  check(g3.blocked === false && !g3.removed, "untriggered text carries no removal reason");
}

/* ── 3. the actual early Current/Historical call, executed ── */
console.log("");
console.log("3 - the route's own early governFactualNarrative statement");
{
  const file = "app/api/query/route.ts";
  const src = fs.readFileSync(path.resolve(file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  let stmt: ts.Statement | null = null;
  const visit = (n: ts.Node): void => {
    if (stmt) return;
    // Whitespace-insensitive: the call spans lines, so a literal substring would miss it.
    if (ts.isExpressionStatement(n)) {
      const flat = n.getText(sf).replace(/\s+/g, "");
      if (flat.includes("governFactualNarrative(claude.explanation") && flat.includes("initialState")) { stmt = n; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  check(stmt !== null, "the early Current/Historical governFactualNarrative statement must be findable");
  if (stmt) {
    const text = (stmt as ts.Statement).getText(sf);
    const line = sf.getLineAndCharacterOfPosition((stmt as ts.Statement).getStart(sf)).line + 1;
    console.log(`  ${file}:${line}  ${text.slice(0, 100)}`);

    const rows = GC073_ROWS;
    const claude: Record<string, unknown> = {
      explanation: "Baltimore, MD recorded 194 murders in 2024. Several cities recorded zero prosecution-declined clearances. " + CAVEAT,
    };
    const initialState = genericResultState({ sql: GC073_SQL, rows });
    const js = ts.transpileModule(`function __run(){${text}}\n__run();`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const fn = new Function("claude", "initialState", "rows", "governFactualNarrative", js) as (...a: unknown[]) => void;
    fn(claude, initialState, rows, governFactualNarrative);

    const out = String(claude.explanation);
    console.log(`  delivered: ${JSON.stringify(out.slice(0, 100))}`);
    check(/194 murders/.test(out), "the route's first delivery must keep the supported figure");
    check(out.includes("FBI's NIBRS program"), "the route's first delivery must keep the caveat");
    check(!EMPTY_STATE_MESSAGE_FRAGMENT.test(out), "the route must not send the empty-state message for a populated result");
    check(!/zero prosecution-declined/.test(out), "the route must drop the unsupported sentence");
  }
}

/* ── 4. empty / unknown: every named form stays blocked ── */
console.log("");
console.log("4 - empty result, conservative enforcement");
{
  const empty = genericResultState({ sql: "SELECT SUM(x) FROM t WHERE ori='X'", rows: [] });
  const MUST_BLOCK = [
    "There were zero murders in Ward, AR in 2024.",
    "There were 0 murders in Ward, AR in 2024.",
    "Ward, AR recorded 0 murders in 2024.",
    "The total was 0.",
    "Murders in Ward, AR in 2024: 0",
    "None were reported in Ward, AR in 2024.",
    "No data is available for Ward, AR in 2024.",
    "Ward, AR does not participate in this program.",
    "That place is not in our dataset.",
  ];
  for (const c of MUST_BLOCK) {
    const g = guardEmptyStateWording(c, empty, { hasFigures: false });
    check(g.blocked && EMPTY_STATE_MESSAGE_FRAGMENT.test(g.safeText), `must stay blocked on an empty result: ${JSON.stringify(c)}`);
  }
  // Absent context must behave as conservatively as an explicit empty one.
  const noCtx = guardEmptyStateWording("There were 0 murders in Ward, AR in 2024.", empty);
  check(noCtx.blocked, "omitted row context must remain conservative, never guessed from prose");

  // A product failure outranks everything, rows or not.
  const fail = classifyResultState({
    queryCompleted: false, productError: "timeout", requestResolved: null, periodInCoverage: null,
    entityInCoverage: null, reportingExpected: null, queryRepresentsRequest: null, measuredValue: null, rowCount: 35,
  });
  const gf = guardEmptyStateWording("Baltimore recorded 194 murders. There were zero elsewhere.", fail, { hasFigures: true });
  check(gf.blocked && /failure on our side/i.test(gf.safeText), "a product failure still replaces unconditionally, even with rows");
  const guided = governFactualNarrative("Server error: boom", fail, "Try a single place, period and offense.", { hasFigures: true });
  check(/failure on our side/i.test(guided) && /Try a single place/.test(guided), "trusted guidance still survives a failure (G1)");

  // An established state authorizes only its own claims.
  const outside = classifyResultState({
    queryCompleted: true, requestResolved: true, periodInCoverage: true, entityInCoverage: false,
    reportingExpected: null, queryRepresentsRequest: null, measuredValue: null, rowCount: 0,
  });
  const cross = guardEmptyStateWording("There were zero murders there in 2024.", outside, { hasFigures: false });
  check(cross.blocked, "outside coverage does not authorize a true-zero claim");
}

/* ── 5. numeral scoping: what must NOT trip ── */
console.log("");
console.log("5 - numeral scoping negatives");
{
  const empty = genericResultState({ sql: "SELECT 1", rows: [] });
  const populated = genericResultState({ sql: "SELECT 1", rows: [{ a: 1 }] });
  const MUST_NOT_TRIP: Array<[string, boolean]> = [
    ["Murders in Chicago in 2024.", false],
    ["Covering 2020-2024 for all agencies.", false],
    ["The agency ORI is TX0101000.", false],
    ["That is a 0.7% share of the total.", false],
    ["There were 10 murders in 2024.", false],
    ["Rates are reported per 100,000 residents.", false],
    ["The figure fell to 0.5 per 100,000.", false],
  ];
  for (const [text, expectBlocked] of MUST_NOT_TRIP) {
    const g = guardEmptyStateWording(text, empty, { hasFigures: false });
    check(g.blocked === expectBlocked, `must not trip on an empty result: ${JSON.stringify(text)}`);
  }
  /*
   * A zero-valued cell inside a rendered table is a returned figure, not an assertion: it is
   * a delimited column, not `label: value` prose. This is the genuine positive.
   */
  const table = "Murder clearances for 2024.\n\n| City | Cleared | Prosecution declined |\n| --- | --- | --- |\n| Atlanta | 47 | 0 |\n| Austin | 50 | 0 |";
  const gt = guardEmptyStateWording(table, populated, { hasFigures: true });
  check(gt.safeText === table, "zero-valued table cells in a populated answer are preserved");

  /*
   * CORRECTED (review R1). An earlier version of this check asserted the opposite — that
   * "Prosecution declined: 0" is "a returned cell" whenever any row exists — and the source
   * carried a matching `populatedExempt` exemption. Both were wrong: neither a `[{a:1}]` row
   * nor a boolean establishes that such a cell was returned, and skipping the rule let row
   * presence decide whether the claim was CHECKED. A freestanding labelled zero is a claim.
   */
  const labelled = "Prosecution declined: 0";
  const gl = guardEmptyStateWording(labelled, populated, { hasFigures: true });
  check(gl.blocked === true, "a freestanding labelled zero is still checked when rows exist");
  check(!/:\s*0\s*$/m.test(gl.safeText), "an unproved labelled zero is removed, not delivered");

  /* The two controls from the review probe, at the guard seam. */
  const nullAgg = genericResultState({ sql: "SELECT SUM(x) AS total_murders FROM t", rows: [{ total_murders: null }] });
  const gNull = guardEmptyStateWording("Murders in Ward, AR in 2024: 0", nullAgg, { hasFigures: true });
  check(gNull.blocked === true, "a null aggregate does not authorize a labelled zero");
  check(!/Ward, AR in 2024: 0/.test(gNull.safeText), "the unsupported Ward statement is removed");

  const chicagoOnly = genericResultState({ sql: "SELECT city, murders FROM t", rows: [{ city: "Chicago", state: "IL", murders: 512 }] });
  const gOther = guardEmptyStateWording("Murders in Ward, AR in 2024: 0", chicagoOnly, { hasFigures: true });
  check(gOther.blocked === true, "another city's figure does not authorize a Ward zero");
  check(!/Ward, AR in 2024: 0/.test(gOther.safeText), "the unsupported Ward statement is removed");

  /* Crossed: a supported sentence and the caveat survive while the labelled claim goes. */
  const crossed = guardEmptyStateWording(
    `Chicago, IL recorded 512 murders in 2024.\nMurders in Ward, AR in 2024: 0\n${CAVEAT}`,
    chicagoOnly, { hasFigures: true });
  check(/512 murders/.test(crossed.safeText), "the supported Chicago sentence survives");
  check(crossed.safeText.includes("FBI's NIBRS program"), "the caveat survives");
  check(!/Ward, AR in 2024: 0/.test(crossed.safeText), "the Ward claim does not");

  /* An established true-zero state may still state its own zero. */
  const trueZero = classifyResultState({
    queryCompleted: true, requestResolved: true, periodInCoverage: true, entityInCoverage: true,
    reportingExpected: true, queryRepresentsRequest: true, measuredValue: 0, rowCount: 1,
  });
  check(trueZero.state === "true_zero", `the fixture must reach true_zero (got ${trueZero.state})`);
  const gTz = guardEmptyStateWording("Murders in Ward, AR in 2024: 0", trueZero, { hasFigures: true });
  check(gTz.blocked === false, "an established true zero still authorizes its own labelled zero");

  // The same rule list is read by trusted-guidance validation.
  check(isTrustedGuidanceSafe("Try a single place, period and offense.") === true,
    "the existing narrower-question guidance stays safe");
  check(isTrustedGuidanceSafe("There were 0 murders in Ward, AR in 2024.") === false,
    "a numeral-zero claim must not ride along as trusted guidance");
  check(isTrustedGuidanceSafe("There were zero murders in Ward, AR.") === false,
    "a worded-zero claim must not ride along as trusted guidance");
}

/* ── 6. idempotence and reason shape ── */
console.log("");
console.log("6 - reason shape and re-application");
{
  const state = genericResultState({ sql: GC073_SQL, rows: GC073_ROWS });
  const draft = "Baltimore, MD recorded 194 murders in 2024. Several cities recorded zero clearances. " + CAVEAT;
  const once = guardEmptyStateWording(draft, state, { hasFigures: true });
  const twice = guardEmptyStateWording(once.safeText, state, { hasFigures: true });
  check(twice.safeText === once.safeText, "re-applying the guard to its own output changes nothing");
  check(twice.removed !== true, "the second pass reports no removal");
  check(/194 murders/.test(twice.safeText), "the retained answer survives re-application");
  const notices = (twice.safeText.match(/omitted because/gi) || []).length;
  check(notices <= 1, `no repeated notice (found ${notices})`);
}

/* ── 7. the shared chokepoint uses the guarded output ── */
console.log("");
console.log("7 - applyResultDisclosures end to end");
{
  const rows = GC073_ROWS;
  const out = applyResultDisclosures({
    explanation: "Baltimore, MD recorded 194 murders in 2024. Several cities recorded zero prosecution-declined clearances. " + CAVEAT,
    question: "murder clearances by type for these cities in 2024",
    sql: GC073_SQL, rows, tab: "nibrs",
    resultState: genericResultState({ sql: GC073_SQL, rows }),
  });
  console.log(`  ${JSON.stringify(out.slice(0, 110))}`);
  check(/194 murders/.test(out), "the chokepoint delivers the supported figure");
  check(out.includes("FBI's NIBRS program"), "the chokepoint keeps the caveat");
  check(!EMPTY_STATE_MESSAGE_FRAGMENT.test(out), "the chokepoint does not emit the empty-state message");
  check(!/zero prosecution-declined/.test(out), "the chokepoint drops the unsupported sentence");
}

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
