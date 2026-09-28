/**
 * Bounded ratio support: BEHAVIORAL proof, in two halves.
 *
 * WHY TWO HALVES. `2026-09-08-folded-correction-proposal-codex-ruling.md` §3A-B requires that a
 * supported request reach the reader with the right figure, and that the expected figure come from
 * an inspectable local fixture rather than from the old captured answer. So:
 *
 *   HALF 1 - the decision. Does the structural layer accept a completed ratio and keep rejecting an
 *   incomplete one? Saved captures supply the questions, SQL shapes and contracts. This is the gate
 *   that produced the measured failures.
 *
 *   HALF 2 - the arithmetic. Run the accepted shapes against a small SQLite fixture whose rows are
 *   written here, and compare against a share computed independently in this file. This is what
 *   makes "delivered the right figure" a claim rather than an assumption.
 *
 * WHAT THIS DOES NOT PROVE, stated because it matters. Half 1 feeds SQL that already exists, and
 * Half 2 executes SQL written here. Neither exercises the live generation path, so neither shows
 * that the model will WRITE a completed ratio. If generation needs its own change that is a
 * residual, not something this file demonstrates.
 *
 * No paid calls, no network, no production databases. The fixture is created and deleted here.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { evaluateStructuralSemantics } from "../lib/structural-semantics";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import type { QueryContract, QueryContractSource } from "../lib/query-contract";

const REVIEW = path.resolve(
  __dirname,
  "../audit/correctness-candidate-2026-09-08/codex-validator-review.json"
);

type ReviewRow = {
  caseId: string;
  question: string;
  source: QueryContractSource;
  sql: string;
  loggedError: string;
  capturedContract: QueryContract;
};

const rows: ReviewRow[] = JSON.parse(fs.readFileSync(REVIEW, "utf8")).rows;
const byCase = new Map(rows.map((r) => [r.caseId, r]));

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${message}`);
  }
}

function ruleIds(row: ReviewRow, sqlOverride?: string): string[] {
  return evaluateStructuralSemantics({
    question: row.question,
    source: row.source,
    contract: row.capturedContract,
    sql: sqlOverride ?? row.sql,
  }).map((f) => f.ruleId);
}

const UNMODELED = "structural-measure-unit-unmodeled";

/* ------------------------------------------------------------------ */
/*  HALF 1 - the decision                                              */
/* ------------------------------------------------------------------ */
console.log("HALF 1 - structural decision");
console.log("");

// Saved SQL that DOES compute the ratio. Must be accepted.
console.log("  completed ratios in the saved SQL - must be accepted");
for (const id of ["GC-032", "GC-034"]) {
  const row = byCase.get(id)!;
  check(!ruleIds(row).includes(UNMODELED), `${id}: completed ratio must not be rejected as unmodeled`);
}

// Saved SQL that does NOT divide. Must stay rejected - counts are ingredients, not a share.
console.log("  count-only saved SQL - must stay rejected");
for (const id of ["GC-033", "GC-035"]) {
  const row = byCase.get(id)!;
  check(ruleIds(row).includes(UNMODELED), `${id}: count-only SQL must stay rejected as unmodeled`);
}

// The same two QUESTIONS, with explicitly constructed SQL that does compute the ratio.
// These are local positive fixtures, labelled as constructed. They are not frozen-set cases and
// they are not model output.
console.log("  CONSTRUCTED completed variants of the same two questions - must be accepted");
const CONSTRUCTED: Record<string, string> = {
  "GC-033":
    "SELECT ROUND(100.0 * SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_male, " +
    "SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) AS male_victims, COUNT(*) AS total_victims " +
    "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
    "WHERE i.state = 'TX' AND i.year = 2023 AND i.homicide_type = 'Murder' LIMIT 1000",
  "GC-035":
    "SELECT i.year, ROUND(1.0 * SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) / " +
    "NULLIF(SUM(CASE WHEN v.sex = 'Female' THEN 1 ELSE 0 END), 0), 2) AS male_to_female_ratio " +
    "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
    "WHERE i.ori = 'PAPEP00' AND i.year >= 2010 AND i.homicide_type = 'Murder' " +
    "GROUP BY i.year ORDER BY i.year LIMIT 1000",
};
for (const [id, sql] of Object.entries(CONSTRUCTED)) {
  const row = byCase.get(id)!;
  check(!ruleIds(row, sql).includes(UNMODELED), `${id}: constructed completed ratio must be accepted`);
}

/*
 * REVIEW COUNTEREXAMPLES (2026-09-08-correction-batch-review-ratio-and-delivery-gaps.md R1).
 *
 * The first version of this batch accepted a ratio whenever ANY returned expression divided and any
 * denominator reference sat on a metric table. That is a statement-wide test, not a proof about the
 * requested calculation, and it let three invalid shapes through. All three are the SAME defect --
 * the denominator's MEANING was never established -- so they are fixed once, not blacklisted
 * individually.
 *
 * Denominators are loaded from the saved Codex diagnostic so the regression evidence and the test
 * cannot drift apart.
 */
const DIAG = path.resolve(
  __dirname,
  "../audit/correctness-candidate-2026-09-08/codex-ratio-batch-review.json"
);
const diag = JSON.parse(fs.readFileSync(DIAG, "utf8"));
/*
 * SECOND-ROUND COUNTEREXAMPLES (2026-09-08-corrected-batch-review-shared-ratio-rule.md §3).
 *
 * The first correction bound the proof to one expression but kept two holes:
 *   - the CALLER still waived the requirement statement-wide via `factual.some(...)`, so a genuine
 *     share in a helper column could authorise a raw count returned as the answer;
 *   - the no-refs branch tested whether the denominator TEXT contained COUNT, which `COUNT(*) * 2.0`
 *     satisfies while halving the percentage.
 * Derived from the saved evidence by the same substitutions the reviewer diagnostic used, so the
 * cases cannot drift from the recorded regression.
 */
const SECOND_ROUND: Array<{ name: string; expected: "accept" | "reject"; sql: string }> = (() => {
  const results = diag.results as Array<{ name: string; expected: string; sql: string }>;
  const valid = results.find((r) => r.expected === "accept")!.sql;
  const decorative = results.find((r) => r.name.startsWith("decorative"))!.sql;
  return [
    {
      name: "raw male count plus unrelated valid female share",
      expected: "reject",
      sql: decorative.replace(
        "COUNT(*) / 1.0 AS helper",
        "100.0 * SUM(CASE WHEN v.sex = 'Female' THEN 1 ELSE 0 END) / COUNT(*) AS helper"
      ),
    },
    {
      name: "twice the actual denominator halves the requested percentage",
      expected: "reject",
      sql: valid.replace("/ COUNT(*)", "/ (COUNT(*) * 2.0)"),
    },
  ];
})();

/*
 * THIRD-ROUND COUNTEREXAMPLES (2026-09-08-shared-ratio-completion-review-request-meaning.md §3).
 *
 * The label rule was a surrogate: renaming the column restored acceptance of the identical wrong
 * arithmetic, and a female share labelled `pct_male` was accepted for a male question. Neither
 * expression's MEANING was ever compared with the request. Fixed by reading the operands from the
 * original SQL, where the quoted literals still exist.
 */
const THIRD_ROUND: Array<{ name: string; expected: "reject"; sql: string }> = (() => {
  const results = diag.results as Array<{ name: string; expected: string; sql: string }>;
  const valid = results.find((r) => r.expected === "accept")!.sql;
  const decorative = results.find((r) => r.name.startsWith("decorative"))!.sql;
  const femaleHelper = decorative.replace(
    "COUNT(*) / 1.0 AS helper",
    "100.0 * SUM(CASE WHEN v.sex = 'Female' THEN 1 ELSE 0 END) / COUNT(*) AS helper"
  );
  return [
    {
      name: "identical wrong calculation; only pct_male renamed male_victims",
      expected: "reject",
      sql: femaleHelper.replace("AS pct_male", "AS male_victims"),
    },
    {
      name: "single female percentage labelled pct_male for the male question",
      expected: "reject",
      sql: valid.replace("v.sex = 'Male'", "v.sex = 'Female'"),
    },
  ];
})();

/*
 * FOURTH-ROUND: ORDERED OPERAND ROLES
 * (2026-09-08-delivery-accepted-ratio-operand-roles-ruling.md §3).
 *
 * The word-presence check had no notion of ORDER. Both "male" and "female" occur in a male-to-female
 * request, so male/female, female/male and male/all-victims all passed - three different answers
 * (2, 0.5 and ~0.67 on the delivery fixture). My previous record claimed this mechanism bound a
 * female denominator rather than a total; that claim was untested and the executable result
 * contradicts it.
 *
 * The opposite-direction case is included so the rule is shown to follow the REQUESTED order rather
 * than hard-coding Male as the numerator.
 */
const GC035_RATIO_Q = "ratio of male to female homicide victims in philadelphia by year since 2010";
const GC035_TAIL =
  "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
  "WHERE i.ori = 'PAPEP00' AND i.year >= 2010 AND i.homicide_type = 'Murder' " +
  "GROUP BY i.year ORDER BY i.year LIMIT 1000";
const orderedRatioSql = (numerator: string, denominator: string) =>
  `SELECT i.year, ROUND(1.0 * ${numerator} / ${denominator}, 2) AS male_to_female_ratio ${GC035_TAIL}`;
const countOf = (sex: string) => `SUM(CASE WHEN v.sex = '${sex}' THEN 1 ELSE 0 END)`;
const nullIf = (expr: string) => `NULLIF(${expr}, 0)`;

const ORDERED_ROLES: Array<{ name: string; question: string; expected: "accept" | "reject"; sql: string }> = [
  {
    name: "requested male divided by female", question: GC035_RATIO_Q, expected: "accept",
    sql: orderedRatioSql(countOf("Male"), nullIf(countOf("Female"))),
  },
  {
    name: "reversed female divided by male", question: GC035_RATIO_Q, expected: "reject",
    sql: orderedRatioSql(countOf("Female"), nullIf(countOf("Male"))),
  },
  {
    name: "male divided by total victims, not female victims", question: GC035_RATIO_Q, expected: "reject",
    sql: orderedRatioSql(countOf("Male"), nullIf("COUNT(*)")),
  },
  // Opposite direction: the rule must follow the request, not a fixed numerator.
  {
    name: "opposite request, female to male, correct order", expected: "accept",
    question: "ratio of female to male homicide victims in philadelphia by year since 2010",
    sql: orderedRatioSql(countOf("Female"), nullIf(countOf("Male"))),
  },
  {
    name: "opposite request, female to male, reversed", expected: "reject",
    question: "ratio of female to male homicide victims in philadelphia by year since 2010",
    sql: orderedRatioSql(countOf("Male"), nullIf(countOf("Female"))),
  },
];

/*
 * FIFTH-ROUND: WHAT EACH OPERAND ACTUALLY COUNTS
 * (2026-09-08-ordered-roles-review-count-meaning.md §3).
 *
 * Direction was right but the operand description was not. It recorded only whether a conditional
 * KEYWORD appeared and which values were quoted, so:
 *   - COUNT(*) / COUNT(*) skipped role checking entirely and established neither subset;
 *   - SUM(CASE WHEN sex = 'Female' THEN 0 ELSE 1 END) mentions Female while counting NON-females.
 * Both yield 1 on the 2010 fixture where the requested answer is 2.
 */
const COUNT_MEANING: Array<{ name: string; expected: "accept" | "reject"; sql: string }> = [
  {
    name: "all victims divided by all victims establishes neither requested subset",
    expected: "reject",
    sql: orderedRatioSql("COUNT(*)", nullIf("COUNT(*)")),
  },
  {
    name: "female literal with inverted CASE contributions counts non-females",
    expected: "reject",
    sql: orderedRatioSql(countOf("Male"), nullIf("SUM(CASE WHEN v.sex = 'Female' THEN 0 ELSE 1 END)")),
  },
];

/*
 * SIXTH-ROUND: MEASURE AND SCALE
 * (2026-09-08-count-meaning-review-measure-and-scale.md §3-4).
 *
 * The recogniser recorded a `weight` - row count versus a summed recorded measure - and the
 * comparison never looked at it, so recorded offenders and summary-row counts were interchangeable.
 * Scaling was stripped to find the inner aggregate and then discarded, so any multiplier passed.
 * On the existing GC-032 fixture (40 youth offenders of 200, across 4 summary rows of which 2 are
 * youth rows) the correct answer is 20%; the three invalid probes compute 1000%, 1% and 40%.
 */
const GC032_Q = "what share of serious violent crimes in California are committed by youth under 18?";
const GC032_TAIL =
  "FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 " +
  "AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A')";
const shareSql = (scale: string, numerator: string, denominator: string) =>
  `SELECT ROUND(${scale} * ${numerator} / ${denominator}, 1) AS pct_under_18 ${GC032_TAIL}`;
const youthOffenders = "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END)";
const youthRows = "SUM(CASE WHEN d.age_group = 'Under 18' THEN 1 ELSE 0 END)";
const totalOffenders = "SUM(d.offender_count)";

const MEASURE_AND_SCALE: Array<{ name: string; expected: "accept" | "reject"; sql: string }> = [
  {
    name: "recorded youth offenders divided by recorded total offenders", expected: "accept",
    sql: shareSql("100.0", youthOffenders, totalOffenders),
  },
  {
    name: "recorded youth offenders divided by summary-row count", expected: "reject",
    sql: shareSql("100.0", youthOffenders, "COUNT(*)"),
  },
  {
    name: "youth summary-row count divided by recorded total offenders", expected: "reject",
    sql: shareSql("100.0", youthRows, totalOffenders),
  },
  {
    name: "twice the percentage from a 200 multiplier", expected: "reject",
    sql: shareSql("200.0", youthOffenders, totalOffenders),
  },
];

/*
 * SEVENTH-ROUND: IS THE MATCHED MEASURE THE REQUESTED ONE?
 * (2026-09-08-measure-scale-review-requested-quantity-and-pending-suite.md §3).
 *
 * Measure EQUALITY was necessary but not sufficient. Counting summary ROWS on both sides agrees with
 * itself and was accepted for the offender-share question - but a demographic summary row is not one
 * offender. On the existing fixture two of four rows are youth rows while 40 of 200 recorded
 * offenders are youth: 50% against the required 20%.
 *
 * I had recorded this as "assumed, governed by the topic checks". It was not, and labelling an
 * unverified requirement as assumed does not discharge it.
 */
const REQUESTED_MEASURE: Array<{ name: string; expected: "accept" | "reject"; sql: string }> = [
  {
    name: "share of recorded offenders, as required", expected: "accept",
    sql: shareSql("100.0", youthOffenders, totalOffenders),
  },
  {
    name: "share of summary rows - both measures agree but neither counts offenders",
    expected: "reject",
    sql: shareSql("100.0", youthRows, "COUNT(*)"),
  },
];

/*
 * EIGHTH-ROUND: SOURCE BINDING MATRIX
 * (2026-09-08-source-binding-review-resolve-before-compare.md §3-4).
 *
 * Two faults, both mine:
 *   1. `sameQuantity` compared a qualified operand's table against `null` for an unqualified one,
 *      BEFORE either had been resolved. So the same column written two ways in a single-source
 *      statement was falsely refused.
 *   2. I argued in the previous record that no new probe was needed because the positives held the
 *      binding in place. That was wrong: existing positives cannot show that breaking a NEW
 *      rejection rule would be detected. This matrix is that missing test.
 *
 * All four positives are the same approved GC-032 calculation over one source table; only the
 * spelling of the two references changes.
 */
const BINDING_MATRIX: Array<{ name: string; expected: "accept" | "reject"; sql: string }> = [
  {
    name: "both qualified", expected: "accept",
    sql: shareSql("100.0", youthOffenders, "SUM(d.offender_count)"),
  },
  {
    name: "both unqualified, one source", expected: "accept",
    sql: shareSql("100.0",
      "SUM(CASE WHEN d.age_group = 'Under 18' THEN offender_count ELSE 0 END)",
      "SUM(offender_count)"),
  },
  {
    name: "unqualified numerator, qualified denominator, same sole source", expected: "accept",
    sql: shareSql("100.0",
      "SUM(CASE WHEN d.age_group = 'Under 18' THEN offender_count ELSE 0 END)",
      "SUM(d.offender_count)"),
  },
  {
    name: "qualified numerator, unqualified denominator, same sole source", expected: "accept",
    sql: shareSql("100.0", youthOffenders, "SUM(offender_count)"),
  },
  {
    name: "undeclared measure column on the declared table", expected: "reject",
    sql: shareSql("100.0",
      "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.other_count ELSE 0 END)",
      "SUM(d.other_count)"),
  },
  {
    name: "weighted measure on an undeclared table", expected: "reject",
    sql: "SELECT ROUND(100.0 * SUM(CASE WHEN d.age_group = 'Under 18' THEN d.victim_count ELSE 0 END) " +
      "/ SUM(d.victim_count), 1) AS pct_under_18 FROM summary_victim_demographics d " +
      "WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 " +
      "AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A')",
  },
  {
    // Mine, to hold the no-fallback rule: an unknown alias must stay unresolved rather than quietly
    // searching the base tables for something that declares the column.
    name: "unknown alias must not fall back to the unqualified search", expected: "reject",
    sql: shareSql("100.0",
      "SUM(CASE WHEN d.age_group = 'Under 18' THEN zz.offender_count ELSE 0 END)",
      "SUM(zz.offender_count)"),
  },
];

console.log("  SOURCE BINDING MATRIX - resolve both references, then compare");
{
  const gc032 = byCase.get("GC-032")!;
  for (const r of BINDING_MATRIX) {
    const v = validateQueryContractSql({ question: GC032_Q, source: gc032.source, sql: r.sql });
    const refused = v.retryIssues.length > 0 || v.blockReasons.length > 0;
    const detail = [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)";
    if (r.expected === "accept") check(!refused, `binding: must ACCEPT "${r.name}" (got: ${detail})`);
    else check(refused, `binding: must REFUSE "${r.name}" (got: ${detail})`);
  }
}

console.log("  REQUESTED MEASURE - what a row of the source actually means");
{
  const gc032 = byCase.get("GC-032")!;
  for (const r of REQUESTED_MEASURE) {
    const v = validateQueryContractSql({ question: GC032_Q, source: gc032.source, sql: r.sql });
    const refused = v.retryIssues.length > 0 || v.blockReasons.length > 0;
    const detail = [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)";
    if (r.expected === "accept") check(!refused, `requested measure: must ACCEPT "${r.name}" (got: ${detail})`);
    else check(refused, `requested measure: must REFUSE "${r.name}" (got: ${detail})`);
  }
}

console.log("  MEASURE AND SCALE - matching quantities and the result form");
{
  const gc032 = byCase.get("GC-032")!;
  for (const r of MEASURE_AND_SCALE) {
    const v = validateQueryContractSql({ question: GC032_Q, source: gc032.source, sql: r.sql });
    const refused = v.retryIssues.length > 0 || v.blockReasons.length > 0;
    const detail = [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)";
    if (r.expected === "accept") check(!refused, `measure/scale: must ACCEPT "${r.name}" (got: ${detail})`);
    else check(refused, `measure/scale: must REFUSE "${r.name}" (got: ${detail})`);
  }
}

console.log("  COUNT MEANING - predicate and row contribution");
{
  const gc035 = byCase.get("GC-035")!;
  for (const r of COUNT_MEANING) {
    const v = validateQueryContractSql({ question: GC035_RATIO_Q, source: gc035.source, sql: r.sql });
    const refused = v.retryIssues.length > 0 || v.blockReasons.length > 0;
    const detail = [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)";
    if (r.expected === "accept") check(!refused, `count meaning: must ACCEPT "${r.name}" (got: ${detail})`);
    else check(refused, `count meaning: must REFUSE "${r.name}" (got: ${detail})`);
  }
}

console.log("  ORDERED OPERAND ROLES - direction and total-vs-subset");
{
  const gc035 = byCase.get("GC-035")!;
  for (const r of ORDERED_ROLES) {
    const v = validateQueryContractSql({ question: r.question, source: gc035.source, sql: r.sql });
    const refused = v.retryIssues.length > 0 || v.blockReasons.length > 0;
    const detail = [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)";
    if (r.expected === "accept") check(!refused, `ordered roles: must ACCEPT "${r.name}" (got: ${detail})`);
    else check(refused, `ordered roles: must REFUSE "${r.name}" (got: ${detail})`);
  }
}

console.log("  REVIEW COUNTEREXAMPLES - one relational defect, four shapes");
{
  const gc033 = byCase.get("GC-033")!;
  // The diagnostic's question matches GC-033's, so its contract is the right one to reuse.
  for (const r of diag.results as Array<{ name: string; expected: string; sql: string }>) {
    const ids = ruleIds(gc033, r.sql);
    if (r.expected === "accept") {
      check(!ids.includes(UNMODELED), `counterexample "${r.name}" must be accepted`);
    } else {
      check(ids.includes(UNMODELED), `counterexample "${r.name}" must be REJECTED`);
    }
  }
}

// NEGATIVE PROTECTION, added by this batch. A share of recorded counts divides by another COUNT.
// If the denominator is a POPULATION, the statement is a per-capita rate wearing a share's label --
// an "unrelated denominator" -- and the ratio acceptance must not launder it past the rate rules.
// Prior behavior, stated honestly: before this batch the whole family was rejected on the unit
// label, so this shape was refused too, but incidentally rather than because the denominator was
// examined. This check makes the reason explicit and keeps it refused after the repair.
console.log("  CONSTRUCTED population-denominator shape - must be rejected as an unrelated denominator");
{
  const row = byCase.get("GC-032")!;
  const perCapitaWearingShareLabel =
    "SELECT ROUND(100000.0 * SUM(d.offender_count) / SUM(a.population), 1) AS per_100k " +
    "FROM summary_offender_demographics d JOIN agencies a ON a.state = d.state AND a.year = d.year " +
    "WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 LIMIT 1000";
  // Named precisely rather than "some finding fired": the acceptance must decline to treat a
  // population denominator as a share, so the unmodeled rejection is exactly what should remain.
  // Measured: `agencies` is not a metric table, so `shareIsComputed` does not accept it.
  check(
    ruleIds(row, perCapitaWearingShareLabel).includes(UNMODELED),
    "population-denominator shape must remain rejected as unmodeled, not accepted as a share"
  );
}

// GC-097 must remain rejected. Its query joins agency-month rows to every agency in the same
// state/year and sums repeated populations; the denominator is not a sound state rate.
console.log("  GC-097 - must remain rejected");
const gc097 = byCase.get("GC-097");
if (gc097) {
  const ids = ruleIds(gc097);
  check(ids.length > 0, "GC-097: must still produce at least one structural finding");
  check(
    ids.includes("structural-returned-series-unresolved") || ids.includes(UNMODELED),
    "GC-097: must still be rejected by a structural rule"
  );
}

/* ------------------------------------------------------------------ */
/*  HALF 1b - the FULL contract validator, not one rule id             */
/* ------------------------------------------------------------------ */
/*
 * Review R1 required confirming rejection "through the full contract-validation entry point, not
 * just one rule ID disappearing". `evaluateStructuralSemantics` is one layer; the route calls
 * `validateQueryContractSql`, which is what actually decides whether a statement is blocked or
 * retried. A rule can stop firing while the statement is still refused elsewhere, or vice versa.
 */
console.log("");
console.log("HALF 1b - full contract validator");
{
  const gc033 = byCase.get("GC-033")!;
  const verdict = (sql: string) => {
    const v = validateQueryContractSql({ question: gc033.question, source: gc033.source, sql });
    return {
      refused: v.retryIssues.length > 0 || v.blockReasons.length > 0,
      detail: [...v.enforced, ...v.retryIssues, ...v.blockReasons].join("; ") || "(clean)",
    };
  };

  for (const r of diag.results as Array<{ name: string; expected: string; sql: string }>) {
    const v = verdict(r.sql);
    if (r.expected === "accept") {
      check(!v.refused, `full validator must accept "${r.name}" (got: ${v.detail})`);
    } else {
      check(v.refused, `full validator must REFUSE "${r.name}" (got: ${v.detail})`);
    }
  }

  // Second- and third-round counterexamples, at the same entry point.
  for (const r of [...SECOND_ROUND, ...THIRD_ROUND]) {
    const v = verdict(r.sql);
    check(v.refused, `full validator must REFUSE "${r.name}" (got: ${v.detail})`);
  }

  // The original count-only saved statements must also be refused by the full validator.
  for (const id of ["GC-033", "GC-035"]) {
    const row = byCase.get(id)!;
    const v = validateQueryContractSql({
      question: row.question, source: row.source, sql: row.sql,
    });
    check(v.retryIssues.length > 0 || v.blockReasons.length > 0,
      `${id}: full validator must refuse the saved count-only statement`);
  }
}

/* ------------------------------------------------------------------ */
/*  HALF 2 - the arithmetic, against a local fixture                   */
/* ------------------------------------------------------------------ */
console.log("");
console.log("HALF 2 - arithmetic on an inspectable fixture");
console.log("");

const dbPath = path.join(os.tmpdir(), `ratio-fixture-${process.pid}.db`);
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);

// Fixture rows, written here so the expected answer can be computed independently below.
// Two years and two states, so a wrong-year or wrong-entity query is detectably different.
db.exec(`
  CREATE TABLE summary_offender_demographics (
    state TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER
  );
`);
const FIXTURE: Array<[string, number, string, string, number]> = [
  ["CA", 2021, "120", "Under 18", 30],
  ["CA", 2021, "120", "18 and over", 70],
  ["CA", 2022, "120", "Under 18", 10],
  ["CA", 2022, "120", "18 and over", 90],
  ["TX", 2021, "120", "Under 18", 99],   // wrong-entity control
  ["CA", 2019, "120", "Under 18", 99],   // wrong-year control (outside 2021-2025)
];
const ins = db.prepare(
  "INSERT INTO summary_offender_demographics VALUES (?, ?, ?, ?, ?)"
);
for (const r of FIXTURE) ins.run(...r);

// Expected share, computed here from the fixture rows and NOT from any captured answer.
const inScope = FIXTURE.filter(
  ([state, year, , ,]) => state === "CA" && year >= 2021 && year <= 2025
);
const under18 = inScope
  .filter(([, , , age]) => age === "Under 18")
  .reduce((a, [, , , , n]) => a + n, 0);
const total = inScope.reduce((a, [, , , , n]) => a + n, 0);
const expectedPct = Math.round((1000 * under18) / total) / 10;
console.log(`  fixture: under-18 offenders ${under18} of ${total} in scope`);
console.log(`  expected share computed here: ${expectedPct}%`);

const ratioSql =
  "SELECT ROUND(100.0 * SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END) " +
  "/ SUM(d.offender_count), 1) AS pct_under_18, " +
  "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END) AS under_18_offenders, " +
  "SUM(d.offender_count) AS total_offenders " +
  "FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 " +
  "AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A')";

const got = db.prepare(ratioSql).get() as {
  pct_under_18: number; under_18_offenders: number; total_offenders: number;
};

check(got.pct_under_18 === expectedPct,
  `delivered share must equal the independently computed ${expectedPct}% (got ${got.pct_under_18})`);
check(got.under_18_offenders === under18,
  `numerator must be ${under18} (got ${got.under_18_offenders})`);
check(got.total_offenders === total,
  `denominator must be ${total} (got ${got.total_offenders})`);

// Controls: the excluded rows must genuinely be excluded, or the figure above proves nothing.
check(total !== FIXTURE.reduce((a, [, , , , n]) => a + n, 0),
  "wrong-entity and wrong-year rows must be excluded from the denominator");

// A counts-only shape over the same fixture yields no share at all - the distinction the
// structural gate exists to preserve.
const countsOnly = db.prepare(
  "SELECT d.age_group, SUM(d.offender_count) AS n FROM summary_offender_demographics d " +
  "WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 GROUP BY d.age_group"
).all() as Array<{ age_group: string; n: number }>;
check(countsOnly.length === 2 && !("pct_under_18" in (countsOnly[0] as object)),
  "counts-only shape must return counts, not a completed share");

db.close();
fs.unlinkSync(dbPath);

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
