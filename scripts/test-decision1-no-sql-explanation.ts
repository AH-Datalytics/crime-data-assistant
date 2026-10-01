/**
 * Decision 1: the no-SQL terminal path must give the reader the honest reason.
 *
 * THE MEASURED DEFECT. GC-006/007/008/009 are classified correctly as court-process requests, but
 * both routes return from their no-SQL branch BEFORE `runGuardrails`, so the `out-of-scope-override`
 * explanation is never consulted. Every one delivered the generic template, whose advice — "restate
 * it with the place, offense, and date range you want" — can never succeed for a conviction-rate
 * question. Correct classification, discarded at delivery.
 *
 * SCOPE, per 2026-09-08-decision-1-scope-ruling-and-build-recommendation.md. This proves the shared
 * terminal selection and the emitted explanation. It does NOT claim to fix GC-001/002 (phantom
 * `all` -> `Ball, LA` geography), GC-003 (crime-type gate) or GC-010's compound handling; those stay
 * failing and are carried here only as controls. Supplied SQL and fixture rows are labelled as such
 * and do not prove the planner generates that SQL.
 *
 * No production database, no live or model contact. Local fixture queries only.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { classifyClearanceReferent, mayRefuseAsCourtProcess } from "../lib/clearance-referent";
import {
  buildNoSqlFallbackMessage,
  neutralizeUnverifiedAvailabilityClaim,
  selectNoSqlRefusal,
} from "../lib/refusal-safety";
import { genericResultState } from "../lib/result-state-adapters";
import { applyResultDisclosures } from "../lib/result-disclosure";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

/** The misleading invitation the generic template carries. */
const REPHRASE_INVITATION = /restate it with the place, offense, and date range/i;

/* ------------------------------------------------------------------ */
/*  A - the four Group A questions must get the court explanation      */
/* ------------------------------------------------------------------ */
console.log("A - court-process requests on the no-SQL path");

const GROUP_A: Array<[string, string, string]> = [
  ["GC-006", "historical", "conviction rates for murders in Houston"],
  ["GC-007", "historical", "how many offenders were sentenced to prison"],
  ["GC-008", "historical", "savannah police officers convicted of corruption related crimes from 1990 - 2024"],
  ["GC-009", "nibrs", "Can you provide one bar per city with the race of defendants reflected in each bar?"],
];

for (const [id, source, question] of GROUP_A) {
  const selected = selectNoSqlRefusal(question, source);
  check(selected.reason === "court-data-out-of-scope",
    `${id}: reason must record the branch actually used (got "${selected.reason}")`);
  check(!REPHRASE_INVITATION.test(selected.explanation),
    `${id}: must not invite restating with place, offense and date range`);
  check(/court/i.test(selected.explanation),
    `${id}: must name court outcomes as the thing not recorded`);
  // Must survive the sanitizer the route applies immediately afterwards.
  const sanitized = neutralizeUnverifiedAvailabilityClaim(selected.explanation, "Historical Library");
  check(sanitized === selected.explanation,
    `${id}: explanation must survive neutralizeUnverifiedAvailabilityClaim unchanged`);
}

/* ------------------------------------------------------------------ */
/*  B - supported clearance questions must NOT gain a court refusal    */
/* ------------------------------------------------------------------ */
console.log("");
console.log("B - supported police-clearance controls keep their current behaviour");

const SUPPORTED_CONTROLS: Array<[string, string]> = [
  ["GC-001", "give me the share of all rape clearances that were prosecution declined in 2025 by state"],
  ["GC-002", "give me the share of all rape clearances that were prosecution declined in 2025"],
  ["GC-003", "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?"],
];

for (const [id, question] of SUPPORTED_CONTROLS) {
  const selected = selectNoSqlRefusal(question, "nibrs");
  check(selected.reason === "no-sql-server-template",
    `${id}: must NOT acquire a court refusal (got "${selected.reason}")`);
}

// These three remain FAILING for other reasons - phantom geography and the crime-type gate. This
// control asserts only that the repair adds no court refusal, which is what the ruling requires.

/* ------------------------------------------------------------------ */
/*  C - an unrelated no-SQL request keeps the honest generic response   */
/* ------------------------------------------------------------------ */
console.log("");
console.log("C - unrelated no-SQL request keeps the generic template");
{
  const q = "show me burglaries in Toledo for 2023";
  const selected = selectNoSqlRefusal(q, "current");
  check(selected.reason === "no-sql-server-template",
    "unrelated request must keep the generic template branch");
  check(selected.explanation === buildNoSqlFallbackMessage("current"),
    "unrelated request must get the unchanged generic message");
  check(!/court/i.test(selected.explanation),
    "unrelated request must not acquire a court-data explanation");
}

/* ------------------------------------------------------------------ */
/*  D - GC-010 must not gain a claim that its crime half is missing    */
/* ------------------------------------------------------------------ */
console.log("");
console.log("D - GC-010 negative control against overclaiming");
{
  const q = "Please show me a graph of the violent crime rate back to 1930 and also the U.S. prison population going back that far (or as far as possible)";
  const decision = classifyClearanceReferent(q);
  console.log(`  classifier: referent=${decision.referent} refuseWholeRequest=${decision.refuseWholeRequest}`);
  const selected = selectNoSqlRefusal(q, "historical");
  // The absence claim must be limited to court/corrections records. Reported crime must not be
  // described as unavailable, and the whole request must not be called unsupported.
  check(/reported crime/i.test(selected.explanation),
    "GC-010: explanation must affirm that reported crime is tracked");
  check(!/entire request|whole request|none of (?:this|that)/i.test(selected.explanation),
    "GC-010: must not declare the whole request unsupported");
  // Its compound handling stays failing and is NOT claimed fixed here.
}

/* ------------------------------------------------------------------ */
/*  E - classifier regression: the seven correct outcomes              */
/* ------------------------------------------------------------------ */
console.log("");
console.log("E - classifier outcomes that must not regress");

for (const [id, , q] of GROUP_A) {
  check(mayRefuseAsCourtProcess(q) === true, `${id}: must classify as court process`);
}
for (const [id, q] of SUPPORTED_CONTROLS) {
  check(mayRefuseAsCourtProcess(q) === false, `${id}: must NOT classify as court process`);
}

/*
 * GC-005 is a KNOWN FAILING CAPABILITY, characterised and not asserted as desired behaviour.
 * "gun prosecutions" is missed by the referent policy; recognising it is the separately identified
 * A-prime residual and no classifier expansion is in this batch. Printed so a change is visible.
 */
{
  const q = "Can you provide the number or percentage of gun prosecutions per year over the last 20 years?";
  const classified = mayRefuseAsCourtProcess(q);
  console.log(`  GC-005 KNOWN RESIDUAL (not asserted): mayRefuseAsCourtProcess = ${classified}` +
    `  -> ${classified ? "would now get the court explanation" : "still gets the generic template"}`);
}

/* ------------------------------------------------------------------ */
/*  F - the SQL-present path is undamaged, on a local fixture          */
/* ------------------------------------------------------------------ */
console.log("");
console.log("F - a supported clearance answer still executes and delivers");

const dbPath = path.join(os.tmpdir(), `d1-clearance-${process.pid}.db`);
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
db.exec(`CREATE TABLE summary_clearance_detail (
  state TEXT, year INTEGER, ucr_offense_code TEXT,
  cleared_by_arrest INTEGER, cleared_B INTEGER, cleared_C INTEGER
);`);
// Fixture rows written here, so the expected share is computed independently below.
const ROWS: Array<[string, number, string, number, number, number]> = [
  ["TX", 2025, "11A", 30, 10, 0],
  ["TX", 2025, "11B", 10, 5, 5],
  ["TX", 2024, "11A", 99, 99, 99],
  ["CA", 2025, "11A", 99, 99, 99],
  ["TX", 2025, "120", 99, 99, 99],
];
const ins = db.prepare("INSERT INTO summary_clearance_detail VALUES (?, ?, ?, ?, ?, ?)");
for (const r of ROWS) ins.run(...r);

const inScope = ROWS.filter(([s, y, code]) => s === "TX" && y === 2025 && ["11A", "11B", "11C"].includes(code));
const declined = inScope.reduce((n, r) => n + r[4], 0);
const allCleared = inScope.reduce((n, r) => n + r[3] + r[4] + r[5], 0);
const expectedShare = Math.round((1000 * declined) / allCleared) / 10;
console.log(`  expected share computed here: ${expectedShare}% (${declined} of ${allCleared} clearances)`);

// INJECTED SQL, labelled: this proves the delivery path, not that the planner writes it. The
// denominator includes arrest clearances, which the question's "all clearances" requires.
const clearanceSql =
  "SELECT ROUND(100.0 * SUM(cleared_B) / NULLIF(SUM(cleared_by_arrest + cleared_B + cleared_C), 0), 1) " +
  "AS prosecution_declined_share FROM summary_clearance_detail " +
  "WHERE state = 'TX' AND year = 2025 AND ucr_offense_code IN ('11A','11B','11C')";
const rows = db.prepare(clearanceSql).all() as Record<string, unknown>[];
check(Number(rows[0]?.prosecution_declined_share) === expectedShare,
  `executed share must be ${expectedShare} (got ${rows[0]?.prosecution_declined_share})`);

/*
 * CONSTRUCTED question, labelled as such, and SCOPED TO THE FIXTURE.
 *
 * The previous version passed GC-001's unscoped "by state" question to a Texas-only answer - the
 * same mismatch class as the GC-035 false positive earlier in this project: correct arithmetic
 * answering a different question. This constructed question matches the fixture's Texas/2025 scope.
 * It does NOT answer or repair GC-001, whose phantom-geography failure is untouched.
 */
const CONSTRUCTED_TEXAS_QUESTION =
  "What share of Texas rape clearances in 2025 were exceptionally cleared because prosecution was declined?";
const decision = genericResultState({ sql: clearanceSql, rows, queryCompleted: true });
const draft = `${rows[0].prosecution_declined_share}% of Texas rape clearances in 2025 were exceptionally cleared because prosecution was declined.`;
const delivered = applyResultDisclosures({
  explanation: draft, question: CONSTRUCTED_TEXAS_QUESTION, sql: clearanceSql, rows,
  tab: "nibrs", resultState: decision,
});
console.log(`  delivered: ${JSON.stringify(delivered.slice(0, 150))}`);
check(delivered.includes(String(expectedShare)), `delivered text must carry ${expectedShare}`);
check(/Texas/i.test(delivered), "delivered text must name the place the fixture actually scopes to");
check(delivered.includes("2025"), "delivered text must name the period the fixture scopes to");
check(/prosecution was declined/i.test(delivered), "delivered text must name the measure");
check(!/by state/i.test(delivered), "delivered text must not claim a by-state breakdown the fixture does not have");
check(!REPHRASE_INVITATION.test(delivered), "a delivered answer must not carry the no-SQL invitation");
check(!/court outcomes/i.test(delivered), "a supported clearance answer must not become a court refusal");

db.close();
fs.unlinkSync(dbPath);

/* ------------------------------------------------------------------ */
/*  G - the old ordering would be caught                               */
/* ------------------------------------------------------------------ */
console.log("");
console.log("G - reverting to the unconditional template is detected");
{
  // Exactly what the routes did before: the generic template regardless of the question.
  let wouldFail = 0;
  for (const [, source] of GROUP_A) {
    const old = buildNoSqlFallbackMessage(source);
    if (REPHRASE_INVITATION.test(old) && !/court/i.test(old)) wouldFail++;
  }
  check(wouldFail === GROUP_A.length,
    `restoring the unconditional template must fail all ${GROUP_A.length} Group A assertions (would fail ${wouldFail})`);
}

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
