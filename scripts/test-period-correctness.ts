/**
 * Decisions 6 and 17: name the months the data actually covers, and never deliver an unverified
 * year-over-year change.
 *
 * THE TWO MEASURED DEFECTS, from the 2026-09-09 repeat capture.
 *
 * D6 — of twelve failing expectations, three returned rows that DO carry month identities and were
 *      still not described: GC-041 (`year`+`month`), GC-042 (`period` as `YYYY-MM`) and GC-049
 *      (scored turn, 63 rows). `monthPointsFromRows` reads only separate year/month columns, and
 *      `returnedMonthRange` was gated to `tab === "current"`.
 * D17 — GC-055 delivered `pct_change: -61.9` for partial 2026 against complete 2025. The figure is a
 *      RETURNED COLUMN computed by the SQL's own `LAG()`, so no wording change removes it.
 *
 * THE CALENDAR IS NOT EVIDENCE. Every adjacent pair is judged on its own month evidence. An earlier
 * version evaluated only pairs touching the current calendar year, so the identical unresolved
 * comparison would have become "supported" the moment the year rolled over. Age is not support.
 *
 * A change column is identified by the query expression aliased to it — a `LAG`/`LEAD` ordered by
 * year — with the arithmetic reconciling and no same-row `part/whole` explanation. Never by its
 * alias, and never by a window that merely sits nearby: that is why `firearm_pct` survives even when
 * an unrelated `LAG(total) ... AS previous_total` is projected beside it.
 *
 * Local only: shipped source and the placed capture. No database, model, network, server, or route
 * import with initialization side effects.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  monthCoverageFromRows,
  findVerifiedChangeColumns,
  decideYearPair,
  withholdUnverifiedChange,
  describeWindowRelations,
} from "../lib/period-comparison";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { genericResultState } from "../lib/result-state-adapters";
import { buildQueryContract } from "../lib/query-contract";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";
import { detectSubCityGeographyOverride } from "../lib/capability-overrides";
import { detectCompletenessQuestion } from "../lib/completeness-intent";
import { getGeoGuidanceIssues } from "../lib/geo-guidance-lite";
import { shouldAskCrimeType } from "../lib/crime-type-clarification";
import { getCountyScopeClarification } from "../lib/county-clarifier";
import { buildCurrentIndexedStatePlan } from "../lib/current-indexed-state-deterministic";
import { buildMultiCityTrendPlan } from "../lib/multi-city-deterministic";
import {
  buildCurrentYoyComparisonPlan,
  buildCurrentYoyComparisonAnswer,
  buildCurrentYoyGroup,
  certifyCurrentYoyYears,
  decideCurrentYoyPairs,
  answerCoversRequiredCells,
  type CurrentYoyAnswerRow,
  type CurrentYoyPeriodRow,
  type CurrentYoyMembershipRow,
} from "../lib/current-yoy-comparison-deterministic";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

const CAP = "audit/correctness-repeat-2026-09-09/run/turns.jsonl";
const turns = fs.readFileSync(CAP, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const parsed = (id: string, idx: number) => {
  const t = turns.find((x) => x.turn.caseId === id && x.turn.turnIndex === idx);
  if (!t) throw new Error(`${id} turn ${idx} not in the capture`);
  return t.attempts[t.attempts.length - 1].parsed;
};

/* ── 1. the three real monthly shapes name the partial year's own months ── */
console.log("1 - month identities from the three captured shapes");

const MONTHLY: Array<[string, number, "current" | "nibrs", number]> = [
  ["GC-041", 0, "current", 77],
  ["GC-042", 0, "current", 53],
  ["GC-049", 1, "nibrs", 63],
];
for (const [id, idx, tab, expectRows] of MONTHLY) {
  const p = parsed(id, idx);
  const rows = p.rows as Record<string, unknown>[];
  check(rows.length === expectRows, `${id}: capture must have ${expectRows} rows (got ${rows.length})`);

  const cov = monthCoverageFromRows(rows);
  const m2026 = cov.get(2026) || [];
  check(m2026.join(",") === "1,2,3,4,5", `${id}: 2026 months must read 1-5 (got ${m2026.join(",") || "none"})`);

  const out = applyResultDisclosures({
    explanation: "BASE.", question: turns.find((t) => t.turn.caseId === id && t.turn.turnIndex === idx)!.turn.question,
    sql: p.sql || "", rows, tab, resultState: genericResultState({ sql: p.sql || "", rows }),
  });
  console.log(`  ${id} [${tab}]: ${JSON.stringify(out.replace("BASE.", "").trim().slice(0, 120))}`);
  check(/January\s*[-–]\s*May 2026/.test(out),
    `${id}: must name the partial year's own months, January-May 2026`);
  // The overall envelope may still appear — it is useful — but it may not be the ONLY period
  // statement, which is what "stands in for" the partial year's own basis would mean.
  const envelope = /January 20(20|21|22)\s*[-–]\s*May 2026/.test(out);
  const basis = /The 2026 figures cover January\s*[-–]\s*May 2026/.test(out);
  check(!envelope || basis,
    `${id}: the multi-year envelope must not stand in for the partial-year basis`);
}

/* ── 2. missing interior months must not hide inside an endpoint range ── */
console.log("");
console.log("2 - interior gaps are not smoothed over");
{
  const gappy = [
    { year: 2026, month: 1, n: 5 }, { year: 2026, month: 2, n: 4 },
    { year: 2026, month: 3, n: 6 }, { year: 2026, month: 5, n: 3 },
  ];
  const cov = monthCoverageFromRows(gappy);
  check((cov.get(2026) || []).join(",") === "1,2,3,5", "the gap is preserved in the coverage map");
  const out = applyResultDisclosures({
    explanation: "BASE.", question: "murders per month in 2026", sql: "SELECT year, month FROM t",
    rows: gappy, tab: "current", resultState: genericResultState({ sql: "x", rows: gappy }),
  });
  check(!/January\s*[-–]\s*May 2026/.test(out), "a gapped set must not be described as a continuous range");
  check(/January, February, March and May 2026/.test(out),
    `a gapped set is listed so the missing April is visible (got ${JSON.stringify(out.replace("BASE.", "").trim().slice(0, 140))})`);
  check(!/\bApril\b/.test(out), "and April is never named as covered");
}

/* ── 3. entities are not merged into invented coverage ── */
console.log("");
console.log("3 - different entities' month sets are not combined");
{
  const two = [
    { period: "2026-01", milwaukee: 3, chicago: 9 },
    { period: "2026-02", milwaukee: 4, chicago: 8 },
  ];
  const cov = monthCoverageFromRows(two);
  check((cov.get(2026) || []).join(",") === "1,2", "YYYY-MM rows are read");
  // NB: "complete" alone would match "incomplete", which is an honest partial-year warning.
  const merged = applyResultDisclosures({
    explanation: "BASE.", question: "compare murders in Milwaukee and Chicago 2026",
    sql: "SELECT printf('%04d-%02d', year, month) AS period", rows: two, tab: "current",
    resultState: genericResultState({ sql: "x", rows: two }),
  });
  check(!/\bevery month\b|\ball months\b|\bcomplete coverage\b|\beach (?:city|agency|entity) reported\b/i.test(merged),
    `no claim that each entity reported every month (got ${JSON.stringify(merged.replace("BASE.", "").trim().slice(0, 120))})`);
  check(/January-February 2026/.test(merged), "the shared returned months are named");
}

/* ── 4. a verified change column is found by arithmetic, not by its name ── */
console.log("");
console.log("4 - change identification");
{
  const p = parsed("GC-055", 0);
  const rows = p.rows as Record<string, unknown>[];
  const found = findVerifiedChangeColumns(rows, p.columns as string[]);
  console.log(`  GC-055 verified change columns: ${JSON.stringify(found.map((f) => `${f.column}<-${f.base}`))}`);
  check(found.length === 1 && found[0].column === "pct_change" && found[0].base === "total",
    "pct_change must be reconciled against total");

  // GC-050's firearm_pct is a within-period share and reconciles against nothing.
  const shares = parsed("GC-050", 1).rows as Record<string, unknown>[];
  const shareCols = findVerifiedChangeColumns(shares, Object.keys(shares[0]));
  check(shareCols.length === 0, `a within-period share must not be taken for a change (got ${JSON.stringify(shareCols)})`);

  // A same-named column that does NOT reconcile is not a verified change either.
  const bogus = [{ year: 2024, total: 100, pct_change: 42 }, { year: 2025, total: 110, pct_change: 99 }];
  check(findVerifiedChangeColumns(bogus, ["year", "total", "pct_change"]).length === 0,
    "an alias alone does not make a column a verified change");
}

/* ── 5. the comparison decision keeps three states ── */
console.log("");
console.log("5 - matched / unequal / unestablished");
{
  const cov = new Map<number, number[]>();
  cov.set(2025, [1, 2, 3, 4, 5]);
  cov.set(2026, [1, 2, 3, 4, 5]);
  check(decideYearPair(2026, 2025, cov, 2026)?.state === "matched", "equal established months are matched");

  const uneq = new Map<number, number[]>();
  uneq.set(2025, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  uneq.set(2026, [1, 2, 3, 4, 5]);
  check(decideYearPair(2026, 2025, uneq, 2026)?.state === "unequal", "different established months are unequal");

  const none = new Map<number, number[]>();
  check(decideYearPair(2026, 2025, none, 2026)?.state === "unestablished",
    "absent month evidence is unestablished, never relabelled");
  check(decideYearPair(2026, 2025, cov, 2026)?.basis !== null, "a matched pair states its basis");

  /*
   * CORRECTED (review R2B). This previously asserted that a past-vs-past pair was "out of scope"
   * and returned null, which is how the identical unresolved GC-055 comparison would have become
   * supported once the calendar rolled to 2027. The calendar is not evidence: every pair is judged
   * on its own month evidence, and absent evidence is unestablished.
   */
  check(decideYearPair(2024, 2023, none, 2026)?.state === "unestablished",
    "a past pair with no month evidence is unestablished, not silently supported");
}

/* ── 6. GC-055: the unverified change is withheld, the counts survive ── */
console.log("");
console.log("6 - GC-055 withholding");
{
  const p = parsed("GC-055", 0);
  const rows = p.rows as Record<string, unknown>[];
  const w = withholdUnverifiedChange({ rows, columns: p.columns as string[], currentYear: 2026 });
  console.log(`  withheld: ${JSON.stringify(w.withheld)}`);
  console.log(`  note: ${JSON.stringify(w.note)}`);
  /*
   * CORRECTED (review R2B). This previously asserted that ONLY 2026 was withheld, which was the
   * calendar cutoff. GC-055's rows carry no month identities for any year, so no pair is
   * established and every change value is withheld. Age is not support.
   */
  check(w.withheld.length === 3 && w.withheld.every((x) => x.column === "pct_change"),
    `every unestablished pair is withheld (got ${JSON.stringify(w.withheld)})`);
  check(w.withheld.some((x) => x.year === 2026), "including the partial-year pair");

  const y = (n: number) => w.rows.find((r) => Number(r.year) === n)!;
  check(y(2026).pct_change === null, "the unverified change is null, not a number");
  check(y(2026).pct_change !== 0, "zero is never substituted");
  check(Number(y(2026).total) === 212880, "the underlying 2026 total is preserved");
  check(Number(y(2025).total) === 559099, "the 2025 total is preserved");
  check(y(2025).pct_change === null, "an earlier pair with no month evidence is withheld too");
  check(y(2024).pct_change === null, "and so is the earliest");
  check(rows[1].pct_change === -1.3 && rows[2].pct_change === -9.7,
    "the executed rows still carry every original value");
  check(typeof w.note === "string" && /2024, 2025 and 2026/.test(w.note!) && /not shown/i.test(w.note!),
    `the withholding is stated, naming the years (got ${JSON.stringify(w.note)})`);
  check(rows[3].pct_change === -61.9, "the ORIGINAL executed rows are not mutated in place");
}

/* ── 7. the first delivery, at the route's own emit site ── */
console.log("");
console.log("7 - the route emits the presentation result, not the raw one");
{
  const file = "app/api/query/route.ts";
  const src = fs.readFileSync(path.resolve(file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);

  // The first factual result emit, and the multi-city deterministic exit, must both consult it.
  const uses = (from: number, to: number) => {
    const text = src.split("\n").slice(from - 1, to).join("\n");
    return /withholdUnverifiedChange|presentation/.test(text);
  };
  check(/from "@\/lib\/period-comparison"/.test(src) || /from "\.\.\/\.\.\/\.\.\/lib\/period-comparison"/.test(src),
    "the route imports the comparison module");

  let firstEmit: ts.Node | undefined;
  let multiCity: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    const t = n.getText(sf);
    // `finalization` is the proof built by finalizeExit({intendedAction:"answer"}), so this names
    // the normal Current/Historical first factual result and nothing else.
    if (!firstEmit && ts.isCallExpression(n) && /^emitFactualPayload\(finalization/.test(t)) firstEmit = n;
    if (!multiCity && ts.isCallExpression(n) && /^emitFactualPayload\(/.test(t) && /multiCityTrend\.explanation/.test(t)) multiCity = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  check(firstEmit !== undefined, "the first factual emit must be findable");
  check(multiCity !== undefined, "the multi-city deterministic emit must be findable");

  /*
   * EXECUTED, not scanned. An earlier version of this section located the emits with the parser and
   * then searched a nearby source window for a helper name — which proves only that a token appears
   * above the emit, not that the emitted payload uses it. The scan below is kept as a tripwire; this
   * block runs the actual statements with GC-041's captured rows and asserts the payload itself.
   */
  const rows41 = parsed("GC-041", 0).rows as Record<string, unknown>[];
  const sql41 = parsed("GC-041", 0).sql as string;
  const wanted = (n: ts.Node) => {
    const t = n.getText(sf);
    if (ts.isVariableStatement(n)) return /^const (?:presentation|deliveredRows|deliveredColumns)\b/.test(t);
    if (ts.isExpressionStatement(n)) return /^claude\.(?:explanation|title)\s*=/.test(t);
    return false;
  };
  // Scope to the MAIN path's block: the route has two `const presentation` declarations, one here
  // and one in the multi-city exit, and collecting both would redeclare the identifier.
  const allNodes: ts.Node[] = [];
  const gather = (n: ts.Node): void => { allNodes.push(n); ts.forEachChild(n, gather); };
  gather(sf);
  const mainPresentation = allNodes
    .filter((n) => ts.isVariableStatement(n) && n.getText(sf).startsWith("const presentation = withholdUnverifiedChange"))
    .at(-1) as ts.Statement | undefined;
  check(mainPresentation !== undefined, "the main-path presentation statement must be findable");
  const block = mainPresentation?.parent;
  const collected: string[] = (block && ts.isBlock(block) ? [...block.statements] : [])
    .filter((n) => n.pos >= (mainPresentation as ts.Statement).pos && wanted(n))
    .map((n) => n.getText(sf));
  check(collected.length >= 3, `the first-answer statements must be findable (found ${collected.length})`);
  const body = collected.join("\n") + "\nreturn { explanation: claude.explanation, rows: deliveredRows };";
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const env: Record<string, unknown> = {
    rows: rows41, columns: Object.keys(rows41[0]), sql: sql41,
    // The presentation call now reads the caller's question for the relevance rule.
    question: turns.find((t) => t.turn.caseId === "GC-041" && t.turn.turnIndex === 0)!.turn.question,
    claude: { explanation: "Monthly murder counts for New York City.", title: "Results" },
    withholdUnverifiedChange,
    governFactualNarrative: (t: string) => t,
    initialState: genericResultState({ sql: sql41, rows: rows41 }),
    singleRowWarning: null, isHistorical: false, reliabilityNote: null,
    withReliabilityNote: (t: string) => t, firedGuardrails: [] as string[],
  };
  let executed: { explanation: string } | null = null;
  try {
    executed = (new Function(...Object.keys(env), js) as (...a: unknown[]) => { explanation: string })(...Object.values(env));
  } catch (e) {
    check(false, `executing the first-answer statements threw: ${(e as Error).message}`);
  }
  if (executed) {
    console.log(`  executed first answer: ${JSON.stringify(String(executed.explanation).slice(0, 110))}`);
    check(/January\s*[-–]\s*May 2026/.test(String(executed.explanation)),
      "the executed first answer names the partial year's months");
  }
  for (const [label, node] of [["first result", firstEmit], ["multi-city", multiCity]] as [string, ts.Node | undefined][]) {
    if (!node) continue;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const ok = uses(Math.max(1, line - 60), line + 10);
    console.log(`  ${label} emit at ${file}:${line} — consults the presentation result: ${ok}`);
    check(ok, `${label}: the emitted payload must come from the presentation result`);
  }
}

/* ── 8. negatives: no period text where there is nothing to describe ── */
console.log("");
console.log("8 - negatives");
{
  const refusal = applyResultDisclosures({
    explanation: "I could not generate a database query for that request.",
    question: "what months does 2026 include?", sql: "", rows: [], tab: "current",
    resultState: genericResultState({ sql: "", rows: [] }),
  });
  check(!/does not establish which months/i.test(refusal), "a refusal gains no month limitation");
  check(!/Returned period/i.test(refusal), "a refusal gains no returned period");

  const complete = [{ year: 2023, murders: 100 }, { year: 2024, murders: 90 }];
  const out = applyResultDisclosures({
    explanation: "Murders in 2023 and 2024.", question: "murders in 2023 and 2024",
    sql: "SELECT year, murders FROM t WHERE year BETWEEN 2023 AND 2024", rows: complete, tab: "nibrs",
    resultState: genericResultState({ sql: "x", rows: complete }),
  });
  check(!/does not establish which months/i.test(out), "an ordinary complete-year answer gains no month limitation");

  // GC-053: a null rate stays unavailable; no note may imply a usable figure came back.
  const p53 = parsed("GC-053", 0);
  const out53 = applyResultDisclosures({
    explanation: "BASE.", question: turns.find((t) => t.turn.caseId === "GC-053")!.turn.question,
    sql: p53.sql || "", rows: p53.rows, tab: "nibrs",
    resultState: genericResultState({ sql: p53.sql || "", rows: p53.rows }),
  });
  check(!/\b(rate|figure) (?:of|is|was)\b/i.test(out53.replace("BASE.", "")),
    "GC-053's note must not imply a usable figure was returned");
}

/* ── 9. GC-050 unchanged ── */
console.log("");
console.log("9 - GC-050 is untouched");
{
  const p = parsed("GC-050", 1);
  const rows = p.rows as Record<string, unknown>[];
  const w = withholdUnverifiedChange({ rows, columns: Object.keys(rows[0]), currentYear: 2026 });
  check(w.withheld.length === 0, "a within-period share ranking withholds nothing");
  check(JSON.stringify(w.rows) === JSON.stringify(rows), "its rows are returned unchanged");
  const out = applyResultDisclosures({
    explanation: "Ranks big cities by firearm share in 2026 through July (partial year data).",
    question: turns.find((t) => t.turn.caseId === "GC-050" && t.turn.turnIndex === 1)!.turn.question,
    sql: p.sql || "", rows, tab: "shr", resultState: genericResultState({ sql: p.sql || "", rows }),
  });
  check(/January\s*[-–]\s*July 2026/.test(out), "GC-050 keeps its January-July 2026 disclosure");
  check(!/does not establish which months/i.test(out), "GC-050 gains no unknown-month limitation");
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * 10-14. The bounded Current comparison path, and the backstop that covers the model path.
 *
 * Authorized by §7 of docs/superpowers/2026-09-10-current-comparison-path-recommendation.md, which
 * governs over that document's body. The acceptance bar is §7.5.
 *
 * EVERY expected value below is computed in this file from the fixture, never taken from a captured
 * bot answer. The fixtures are written here; no production or restored database is opened.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── 10. the backstop: a categorical carrier is a change claim, a prior value is not ── */
console.log("");
console.log("10 - backstop: representation-blind trigger, prior values retained");
{
  // The exact shape the 2026-09-10 capture delivered for GC-055. The control saw no change column
  // at all here, because a string never reconciles arithmetically.
  const CATEGORICAL_SQL = [
    "WITH annual AS (SELECT year, SUM(count) as total FROM national_monthly",
    "  WHERE offense IN ('Murder','Rape','Robbery','Aggravated Assault') GROUP BY year),",
    "with_lag AS (SELECT year, total, LAG(total) OVER (ORDER BY year) as prior_year FROM annual)",
    "SELECT year, total, prior_year,",
    "  CASE WHEN total < prior_year THEN 'Yes' ELSE 'No' END as decreased",
    "FROM with_lag WHERE year >= 2023 AND year <= 2026 ORDER BY year LIMIT 5000",
  ].join("\n");
  const rows: Record<string, unknown>[] = [
    { year: 2023, total: 627498, prior_year: 631184, decreased: "Yes" },
    { year: 2024, total: 619116, prior_year: 627498, decreased: "Yes" },
    { year: 2025, total: 559099, prior_year: 619116, decreased: "Yes" },
    { year: 2026, total: 212880, prior_year: 559099, decreased: "Yes" },
  ];
  const columns = ["year", "total", "prior_year", "decreased"];
  const out = withholdUnverifiedChange({
    rows, columns, sql: CATEGORICAL_SQL,
    explanation: "Annual violent crime counts for 2023-2026. Violent crime decreased in 2026.",
    title: "Violent Crime Decreased Every Year, 2023-2026",
    question: "Did violent crime decrease every year from 2023 to 2026?",
  });

  const withheldCols = new Set(out.withheld.map((w) => w.column));
  check(withheldCols.has("decreased"), "the categorical carrier `decreased` is withheld");
  check(!withheldCols.has("prior_year"),
    "`prior_year` is NOT withheld - a prior-period observation is permitted (Decision 17)");
  check(out.rows.every((r) => r.decreased === null || Number(r.year) === 2023),
    "every unsupported `decreased` value is null, never a string");
  check(out.rows.every((r) => r.prior_year === rows[out.rows.indexOf(r)].prior_year),
    "the prior-year totals are delivered unchanged");
  check(out.rows.every((r, i) => r.total === rows[i].total), "the observed totals are delivered unchanged");
  check(!/decreased in 2026/i.test(out.explanation),
    "the percent-free directional sentence naming a withheld year is removed");
  check(!/Decreased Every Year/i.test(out.title), "the directional title claim does not survive");
  check(/not shown/i.test(out.explanation), "the withholding is stated");

  // Row presence is not the trigger: an unrecognised binding must not certify meaning either.
  const unbound = withholdUnverifiedChange({
    rows, columns, sql: "SELECT year, total, prior_year, decreased FROM some_view ORDER BY year",
    explanation: "Counts.", title: "Counts", question: "how did violent crime change 2023 to 2026",
  });
  check(unbound.withheld.length === 0,
    "an unresolved binding withholds nothing HERE - the declared path owns that case, not this one");
}

/* ── 11. plan scope: the request decides, and only the supported request ── */
console.log("");
console.log("11 - the comparison plan owns only what it can support");
{
  const IN_SCOPE = [
    "Did violent crime decrease every year from 2023 to 2026?",
    "How much did murders increase bv year-over-year from 2019 to 2020",
  ];
  const OUT_OF_SCOPE: Array<[string, string]> = [
    ["How has murder changed since last year?", "years unresolved"],
    ["What is the population estimate for 2026?", "no comparison requested"],
    ["How many murders were there in 2024?", "no comparison requested"],
    ["Show me murder in Chicago vs Detroit from 2020 to 2024", "a place is named"],
    ["How did the murder rate change from 2020 to 2024?", "a rate, not a count"],
    ["Show violent crime by month from 2023 to 2026", "a month breakdown"],
    ["Which cities had the biggest murder increase from 2020 to 2024?", "a ranking"],
  ];
  for (const q of IN_SCOPE) check(buildCurrentYoyComparisonPlan(q) !== null, `in scope: ${q}`);
  for (const [q, why] of OUT_OF_SCOPE) {
    check(buildCurrentYoyComparisonPlan(q) === null, `out of scope (${why}): ${q}`);
  }

  // The operation is recorded even when the years do not resolve. Collapsing the two would let an
  // unresolved comparison be handled as an ordinary count.
  const unresolved = buildQueryContract("How has murder changed since last year?", "current");
  check(unresolved?.comparability.comparison.requested === true,
    "an unresolved comparison request is still recorded as a comparison");
  check(unresolved?.comparability.comparison.years === null, "and its years are null, not guessed");
  const notAComparison = buildQueryContract("What is the population estimate for 2026?", "current");
  check(notAComparison?.comparability.comparison.requested === false,
    "a partial-year question that asks for no comparison is not one (partialYear is not reused)");
  check(notAComparison?.time.partialYear === true, "even though its partialYear flag is set");

  const plan = buildCurrentYoyComparisonPlan("Did violent crime decrease every year from 2023 to 2026?")!;
  check(JSON.stringify(plan.years) === JSON.stringify([2023, 2024, 2025, 2026]),
    "every year in the run is planned, not just the endpoints");
  check(plan.offenses.join(",") === "Murder,Rape,Robbery,Aggravated Assault",
    "violent crime maps to Current's own offense labels, not NIBRS codes");
  check(!/\b09A\b|\b11A\b|\b120\b/.test(plan.sql), "no NIBRS code reaches the Current query");
  check(plan.asksWholeChain === true, "an 'every year' question is marked as a whole-chain claim");
  check(deterministicPlanRefusal({
    question: "Did violent crime decrease every year from 2023 to 2026?",
    source: "current", sql: plan.sql,
  }) === null, "the plan's answer SQL passes the structural guard the route applies");

  /*
   * REACHABILITY. Placement (guard before execution) is proved by
   * test-structural-route-placement.ts. This is the other half: nothing sitting EARLIER in the
   * Current branch claims the anchor questions first, which a gate in the right place would still
   * fail to answer. Only the predicates that can fire on a placeless Current question are checked;
   * the historical-tab gates cannot.
   */
  for (const q of IN_SCOPE) {
    check(detectSubCityGeographyOverride(q) === null, `no sub-city override claims: ${q}`);
    check(detectCompletenessQuestion(q) === null, `no completeness intent claims: ${q}`);
    check(!getGeoGuidanceIssues(q).some((issue) => issue.kind === "blocking"), `no blocking geo clarification: ${q}`);
    check(!shouldAskCrimeType(q, [])?.needsClarification, `no crime-type clarification claims: ${q}`);
    check(getCountyScopeClarification(q, []) === null, `no county scope claims: ${q}`);
    check(buildCurrentIndexedStatePlan(q) === null, `the indexed-state plan does not claim: ${q}`);
    check(buildMultiCityTrendPlan(q, "current") === null, `the multi-city plan does not claim: ${q}`);
  }

  /*
   * All three statements share the same `WITH` prefix verbatim, so the period inventory, the
   * membership and the totals cannot be derived from differently scoped queries. They also run in
   * one call, which is what makes them one snapshot.
   */
  const withOf = (sql: string) => sql.slice(0, sql.indexOf("\nSELECT ") >= 0 ? sql.indexOf("\nSELECT ") : sql.length);
  check(withOf(plan.sql) === withOf(plan.periodSql) && withOf(plan.sql) === withOf(plan.membershipSql)
    && withOf(plan.sql).length > 100,
    "the answer, period and membership reads share one WITH prefix");
  check(/JOIN sample_agencies/.test(plan.sql) && /JOIN sample_agencies/.test(plan.membershipSql),
    "the reads are bounded to the stored reporting sample");
  check(!/RTCI\.sampleAgencyCount|\b558\b/.test(plan.membershipSql),
    "the sample size is read from the table, never from a hard-coded constant");

  /*
   * THE PERIOD INVENTORY IS INDEPENDENT OF THE REQUESTED OFFENCES. `req` must not carry the offence
   * filter, or a month in which the requested offence is wholly absent would silently vanish and
   * make an incomplete period look complete.
   */
  const reqBlock = plan.sql.slice(plan.sql.indexOf("WITH req AS ("), plan.sql.indexOf("), need AS ("));
  check(!/offense/i.test(reqBlock),
    `the required-period inventory does not filter by offence (${JSON.stringify(reqBlock.slice(0, 120))})`);
  check(/am\.count IS NOT NULL/.test(plan.sql) && !/am\.count\s*>\s*0/.test(plan.sql),
    "a valid recorded zero counts as reporting; only a missing or null observation does not");
  check(/HAVING COUNT\(\*\) = \(SELECT n FROM need\)/.test(plan.sql),
    "membership is decided by aggregation in SQL, not by scanning rows in TypeScript");
  check(/JOIN eligible e ON e\.ori = am\.ori/.test(plan.sql),
    "the answer totals are restricted to the selected group");
  check(!/ORDER BY\s+total|change/i.test(plan.sql),
    "selection and ordering never reference a change or a direction");
}

/* ── 12. the fixed comparison group: selection, labels and exclusions ── */
console.log("");
console.log("12 - the fixed comparison group");
{
  const OFFENSES = ["Murder", "Rape", "Robbery", "Aggravated Assault"];
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const periods = (spec: Array<{ year: number; months: number[] }>) =>
    spec.flatMap((s) => s.months.map((month) => ({ year: s.year, month })));
  // Membership carries identifiers only; the starting sample size is its own read.
  const membership = (oris: string[]) => oris.map((ori) => ({ ori }));
  const sample = (n: number) => [{ sample_size: n }];

  // (a) The group is built from the offence-INDEPENDENT period inventory and the SQL's membership.
  const group = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: ALL }, { year: 2020, months: ALL }]),
    membership(["A1", "A2", "A3"]),
    sample(5),
    OFFENSES.length,
  );
  check(group.includedCount === 3 && group.startingSampleSize === 5 && group.excludedCount === 2,
    `included/starting/excluded are counted from the read (${group.includedCount}/${group.startingSampleSize}/${group.excludedCount})`);
  check(group.requiredCellsPerAgency === 24 * OFFENSES.length,
    `required cells per agency = months x offences (${group.requiredCellsPerAgency})`);
  check(group.yearsWithNoPeriods.length === 0, "both requested years have required periods");

  const certs = certifyCurrentYoyYears([2019, 2020], group);
  check(certs.every((c) => c.months !== null), "both years certify against a non-empty group");
  check(/all 3 agencies in the comparison group/.test(certs[0].reason),
    `the reason names the group, not the sample (${certs[0].reason})`);
  const pairs = decideCurrentYoyPairs(certs);
  check(pairs[0].state === "matched" && pairs[0].basis === "January-December",
    "equal certified months are a matched pair with the shared basis named");

  // (b) De-duplication of membership, so a repeated identifier cannot inflate the group.
  const deduped = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: ALL }, { year: 2020, months: ALL }]),
    // A repeated identifier, and a null/blank sentinel that must not be counted as an agency.
    [...membership(["A1", "A2"]), { ori: "A1" }, { ori: "" }, { ori: null as unknown as string }],
    sample(4),
    OFFENSES.length,
  );
  check(deduped.includedCount === 2,
    `a repeated identifier and a blank sentinel do not inflate the group (${deduped.includedCount})`);
  check(deduped.excludedCount === 2, `and the exclusions still reconcile to the sample (${deduped.excludedCount})`);

  /*
   * (c) AN EMPTY GROUP FROM A NONEMPTY SAMPLE. R1: the starting sample size is read from its own
   *     statement, so it must survive the membership rows being absent. It used to be read off
   *     those rows, which reported a starting sample of zero and zero exclusions on this path.
   */
  const empty = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: ALL }, { year: 2020, months: ALL }]),
    [],
    sample(9),
    OFFENSES.length,
  );
  check(empty.includedCount === 0, "an empty membership read yields an empty group");
  check(empty.startingSampleSize === 9,
    `the starting sample survives an empty group (${empty.startingSampleSize}, expected 9)`);
  check(empty.excludedCount === 9,
    `and every sample agency is counted as excluded (${empty.excludedCount}, expected 9)`);
  check(empty.sampleIsEmpty === false,
    "a nonempty sample with no eligible member is NOT reported as an empty sample");

  // (c2) A GENUINELY empty stored sample is a different fact and stays distinguishable.
  const noSample = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: ALL }, { year: 2020, months: ALL }]),
    [],
    sample(0),
    OFFENSES.length,
  );
  check(noSample.sampleIsEmpty === true && noSample.startingSampleSize === 0,
    "an empty stored sample is recorded as such");
  check(noSample.excludedCount === 0,
    "and it excludes nobody, because there was nobody to exclude");

  // (c3) A missing sample read is treated as unknown-zero rather than silently inheriting a count.
  const noSampleRow = buildCurrentYoyGroup([2019, 2020], periods([{ year: 2019, months: ALL }]), [], [], OFFENSES.length);
  check(noSampleRow.startingSampleSize === 0 && noSampleRow.sampleIsEmpty === true,
    "an absent sample row does not invent a sample size");
  const emptyCerts = certifyCurrentYoyYears([2019, 2020], empty);
  check(emptyCerts.every((c) => c.months === null), "and no year certifies");
  check(/no agency reported every requested crime/.test(emptyCerts[0].reason),
    "with a reason a reader can act on");
  check(decideCurrentYoyPairs(emptyCerts)[0].state === "unestablished", "so the pair is unestablished");

  // (d) A requested year with NO observations stays unknown - never a complete empty interval.
  const missingYear = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: ALL }]),          // 2020 absent from the inventory entirely
    membership(["A1", "A2"]),
    sample(2),
    OFFENSES.length,
  );
  check(missingYear.yearsWithNoPeriods.join(",") === "2020", "the absent year is recorded as having no periods");
  const missingCerts = certifyCurrentYoyYears([2019, 2020], missingYear);
  check(missingCerts[0].months !== null && missingCerts[1].months === null,
    "the present year certifies and the absent year does not");
  check(/holds no 2020 observations/.test(missingCerts[1].reason),
    `the absent year is unknown, not complete (${missingCerts[1].reason})`);
  check(missingYear.requiredCellsPerAgency === 12 * OFFENSES.length,
    "and the absent year adds no required cells");

  // (e) Equal membership never licenses unequal months.
  const unequal = decideCurrentYoyPairs(certifyCurrentYoyYears([2025, 2026], buildCurrentYoyGroup(
    [2025, 2026],
    periods([{ year: 2025, months: ALL }, { year: 2026, months: [1, 2, 3, 4, 5] }]),
    membership(["A1", "A2"]),
    sample(2),
    OFFENSES.length,
  )));
  check(unequal[0].state === "unequal",
    "the same agencies across different months are UNEQUAL, not matched");

  // (f) A gapped but equal set still matches, labelled exactly.
  const gapped = decideCurrentYoyPairs(certifyCurrentYoyYears([2025, 2026], buildCurrentYoyGroup(
    [2025, 2026],
    periods([{ year: 2025, months: [1, 2, 4, 5] }, { year: 2026, months: [1, 2, 4, 5] }]),
    membership(["A1"]),
    sample(1),
    OFFENSES.length,
  )));
  check(gapped[0].state === "matched" && gapped[0].basis === "January, February, April and May",
    `an equal gapped set matches with the gap named exactly (${gapped[0].basis})`);

  // (g) The answer read must cover exactly the required cells - no more, no fewer.
  const twoMonthGroup = buildCurrentYoyGroup(
    [2019, 2020],
    periods([{ year: 2019, months: [1] }, { year: 2020, months: [1] }]),
    membership(["A1"]),
    sample(1),
    ["Murder"].length,
  );
  const exact = [
    { year: 2019, month: 1, offense: "Murder", offense_count: 10 },
    { year: 2020, month: 1, offense: "Murder", offense_count: 20 },
  ];
  check(answerCoversRequiredCells(exact, twoMonthGroup, ["Murder"]), "an exact cell set is accepted");
  check(!answerCoversRequiredCells(exact.slice(0, 1), twoMonthGroup, ["Murder"]),
    "a missing required cell is rejected rather than treated as coverage");
  check(!answerCoversRequiredCells(
    [...exact, { year: 2020, month: 2, offense: "Murder", offense_count: 1 }], twoMonthGroup, ["Murder"]),
    "an extra cell outside the required set is rejected too");
  check(answerCoversRequiredCells([], empty, OFFENSES),
    "an empty group legitimately returns no cells");
}

/* ── 12b. R2: an observation is retained, an operation on it is a claim ── */
console.log("");
console.log("12b - R2: observation versus operation, and scoped binding");
{
  const ROWS: Record<string, unknown>[] = [
    { year: 2024, total: 619116, prior_year: 627498, decreased: "Yes" },
    { year: 2025, total: 559099, prior_year: 619116, decreased: "Yes" },
    { year: 2026, total: 212880, prior_year: 559099, decreased: "Yes" },
  ];
  const COLUMNS = ["year", "total", "prior_year", "decreased"];

  /*
   * (a) THE DIRECT PREDICATE. The window is inlined into the CASE rather than reached through an
   *     alias. The earlier code exempted this, because it only asked whether a window appeared
   *     anywhere in the projection - so the identical operation escaped by being written in one
   *     step instead of two.
   */
  const DIRECT_SQL = [
    "SELECT year, total,",
    "  LAG(total) OVER (ORDER BY year) AS prior_year,",
    "  CASE WHEN total < LAG(total) OVER (ORDER BY year) THEN 'Yes' ELSE 'No' END AS decreased",
    "FROM annual ORDER BY year",
  ].join("\n");
  const directRelations = describeWindowRelations(COLUMNS, DIRECT_SQL);
  check(directRelations.prior_year === "observation",
    `a bare lag projection is an observation (got ${directRelations.prior_year})`);
  check(directRelations.decreased === "direct",
    `an inlined predicate over a window is a direct claim (got ${directRelations.decreased})`);
  const directOut = withholdUnverifiedChange({
    rows: ROWS, columns: COLUMNS, sql: DIRECT_SQL,
    explanation: "Violent crime decreased in 2026.", title: "Violent Crime Decreased in 2026",
    question: "did violent crime decrease from 2024 to 2026",
  });
  const directWithheld = new Set(directOut.withheld.map((w) => w.column));
  check(directWithheld.has("decreased"), "the direct categorical predicate is withheld");
  check(!directWithheld.has("prior_year"), "and the bare prior observation is retained");
  /*
   * Every row that HAS a preceding year in the result set. The first returned row has no prior year
   * to compare against here, so nothing is withheld for it — a pre-existing property of
   * `withholdUnverifiedChange`, unchanged by this batch and recorded in the handoff.
   */
  check(directOut.rows.slice(1).every((r) => r.decreased === null),
    "every direct-shape claim value with a preceding year is null");
  check(directOut.rows.every((r, i) => r.prior_year === ROWS[i].prior_year),
    "the prior-year values are delivered unchanged");

  /*
   * (b) THE UNRELATED-SCOPE COUNTEREXAMPLE. An unused CTE defines `prior_year` as a lag; the CTE
   *     actually selected defines it as a constant. Name matching across scopes attributed the
   *     lag's meaning to the constant, which the accepted rule prohibited.
   */
  const CROSS_SCOPE_SQL = [
    "WITH unused AS (",
    "  SELECT year, LAG(total) OVER (ORDER BY year) AS prior_year FROM annual",
    "), selected AS (",
    "  SELECT year, total, 5 AS prior_year FROM annual",
    ")",
    "SELECT year, total, prior_year,",
    "  CASE WHEN total < prior_year THEN 'Yes' ELSE 'No' END AS decreased",
    "FROM selected ORDER BY year",
  ].join("\n");
  const crossRelations = describeWindowRelations(COLUMNS, CROSS_SCOPE_SQL);
  check(crossRelations.decreased === "unresolved",
    `a name defined twice is NOT attributed to the lag (got ${crossRelations.decreased})`);
  check(crossRelations.decreased !== "hop",
    "the unrelated alias in another scope is not claimed as the supported hop");
  const crossOut = withholdUnverifiedChange({
    rows: ROWS, columns: COLUMNS, sql: CROSS_SCOPE_SQL,
    explanation: "Counts.", title: "Counts", question: "did violent crime decrease from 2024 to 2026",
  });
  check(new Set(crossOut.withheld.map((w) => w.column)).has("decreased"),
    "an unresolved binding still withholds the derived value - non-recognition is not safe delivery");
  check(crossRelations.prior_year === "ambiguous_observation",
    `a twice-defined name whose windowed candidate is a bare observation is retained (got ${crossRelations.prior_year})`);
  check(crossOut.rows.every((r, i) => r.prior_year === ROWS[i].prior_year),
    "and the ambiguously-defined observation is left alone, not rewritten");

  /*
   * (b3) F2: A CONFLICTING DEFINITION CAN ITSELF BE THE DELIVERED CLAIM.
   *
   * The review's counterexample. `decreased` is defined twice — a constant in an unused CTE and the
   * real change predicate in the CTE the outer query actually selects. An earlier version called
   * every conflicting definition not-a-claim, reasoning that a referring column would catch it.
   * There is no referring column here: this column IS the answer, so the unsupported change was
   * delivered in the value, the explanation AND the title. That was the original GC-055 defect
   * returning through the policy meant to avoid false positives.
   */
  const SELECTED_CLAIM_SQL = [
    "WITH annual(year, total) AS (VALUES (2025, 100), (2026, 50)),",
    "unused AS (",
    "  SELECT year, total, 'No' AS decreased FROM annual",
    "),",
    "actual AS (",
    "  SELECT year, total,",
    "    CASE WHEN total < LAG(total) OVER (ORDER BY year)",
    "         THEN 'Yes' ELSE 'No' END AS decreased",
    "  FROM annual",
    ")",
    "SELECT year, total, decreased FROM actual ORDER BY year",
  ].join("\n");
  const selectedColumns = ["year", "total", "decreased"];
  const selectedRows: Record<string, unknown>[] = [
    { year: 2025, total: 100, decreased: "No" },
    { year: 2026, total: 50, decreased: "Yes" },
  ];
  const selectedRelations = describeWindowRelations(selectedColumns, SELECTED_CLAIM_SQL);
  check(selectedRelations.decreased === "ambiguous_claim",
    `a conflicting definition that could be a derived change is a claim (got ${selectedRelations.decreased})`);
  const selectedOut = withholdUnverifiedChange({
    rows: selectedRows, columns: selectedColumns, sql: SELECTED_CLAIM_SQL,
    explanation: "Violent crime decreased in 2026.",
    title: "Violent Crime Decreased in 2026",
    question: "did violent crime decrease from 2025 to 2026",
  });
  check(new Set(selectedOut.withheld.map((w) => w.column)).has("decreased"),
    "the selected categorical change is withheld");
  check(selectedOut.rows[1].decreased === null,
    `the unsupported value does not reach the reader (got ${JSON.stringify(selectedOut.rows[1].decreased)})`);
  check(!/decreased in 2026/i.test(selectedOut.explanation),
    "nor does the claim in the explanation");
  check(!/Decreased/i.test(selectedOut.title),
    `nor in the title (got ${JSON.stringify(selectedOut.title)})`);
  check(selectedOut.rows.every((r, i) => r.total === selectedRows[i].total),
    "and the observed totals survive");

  /*
   * (b2) WHY `ambiguous_definition` is not treated as a claim: redefining an alias across CTEs is
   *      ordinary SQL. Here `total` is defined in two CTEs, one of which wraps a window. Judging it
   *      from the name would strip a plain count from an ordinary answer.
   */
  const REPEATED_NAME_SQL = [
    "WITH a AS (SELECT year, LAG(SUM(count)) OVER (ORDER BY year) AS total FROM t GROUP BY year),",
    "b AS (SELECT year, SUM(count) AS total FROM t GROUP BY year)",
    "SELECT year, total FROM b ORDER BY year",
  ].join("\n");
  const repeatedRows: Record<string, unknown>[] = [
    { year: 2024, total: 100 }, { year: 2025, total: 120 },
  ];
  const repeatedOut = withholdUnverifiedChange({
    rows: repeatedRows, columns: ["year", "total"], sql: REPEATED_NAME_SQL,
    explanation: "Counts.", title: "Counts", question: "how many each year",
  });
  check(repeatedOut.withheld.length === 0,
    "a name redefined across CTEs does not make an ordinary count a change claim");
  check(JSON.stringify(repeatedOut.rows) === JSON.stringify(repeatedRows),
    "and those rows are delivered unchanged");
  check(describeWindowRelations(["year", "total"], REPEATED_NAME_SQL).total === "ambiguous_observation",
    "its windowed candidate is a bare observation, which is what keeps it deliverable");

  /*
   * (c) THE SAVED ONE-HOP SHAPE still resolves, because its alias is defined exactly once.
   */
  const HOP_SQL = [
    "WITH annual AS (SELECT year, SUM(count) as total FROM national_monthly GROUP BY year),",
    "with_lag AS (SELECT year, total, LAG(total) OVER (ORDER BY year) as prior_year FROM annual)",
    "SELECT year, total, prior_year,",
    "  CASE WHEN total < prior_year THEN 'Yes' ELSE 'No' END as decreased",
    "FROM with_lag ORDER BY year",
  ].join("\n");
  const hopRelations = describeWindowRelations(COLUMNS, HOP_SQL);
  check(hopRelations.decreased === "hop",
    `the saved one-hop shape resolves as a hop (got ${hopRelations.decreased})`);
  check(hopRelations.prior_year === "observation", "and its alias stays an observation");

  // (d) An ordinary share beside an unrelated lag is still not a claim.
  const SHARE_SQL = "SELECT year, firearm, total, ROUND(100.0*firearm/total,1) AS firearm_pct, " +
    "LAG(total) OVER (ORDER BY year) AS previous_total FROM annual ORDER BY year";
  const shareRelations = describeWindowRelations(
    ["year", "firearm", "total", "firearm_pct", "previous_total"], SHARE_SQL);
  check(shareRelations.firearm_pct === "none", "a same-row share has no window relation");
  check(shareRelations.previous_total === "observation", "and the lag beside it stays an observation");
}

/* ── 12c. R3: the explicitly national request is admitted ── */
console.log("");
console.log("12c - R3: explicitly national requests are in scope");
{
  const DEFAULT_SAMPLE = "Did violent crime decrease every year from 2023 to 2026?";
  const EXPLICIT_NATIONAL = "Did violent crime in the United States decrease every year from 2023 to 2026?";
  const NAMED_CITY = "Did violent crime in Chicago decrease every year from 2023 to 2026?";

  const nationalContract = buildQueryContract(EXPLICIT_NATIONAL, "current");
  check(nationalContract?.geography.kind === "national" && nationalContract?.geography.name === "United States",
    "the contract represents the explicit request as national/United States");

  const defaultPlan = buildCurrentYoyComparisonPlan(DEFAULT_SAMPLE);
  const nationalPlan = buildCurrentYoyComparisonPlan(EXPLICIT_NATIONAL);
  check(defaultPlan !== null, "the default-sample question is in scope");
  check(nationalPlan !== null, "the explicitly national question is in scope too");
  check(buildCurrentYoyComparisonPlan(NAMED_CITY) === null, "a named city is still out of scope");
  check(nationalPlan !== null && defaultPlan !== null && nationalPlan.sql === defaultPlan.sql,
    "and both forms of the national request plan the identical read");
}

/* ── 13. the delivered group-only answer ── */
console.log("");
console.log("13 - the delivered group-only answer");
{
  const plan = buildCurrentYoyComparisonPlan("Did violent crime decrease every year from 2023 to 2026?")!;
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const GROUP_SIZE = 3;
  const STARTING_SAMPLE = 8;

  // Fixture: three full years and a five-month 2026 - the full/full/partial multi-year case.
  const monthsOf: Record<number, number[]> = { 2023: ALL, 2024: ALL, 2025: ALL, 2026: [1, 2, 3, 4, 5] };
  const perCell: Record<number, number> = { 2023: 10, 2024: 9, 2025: 8, 2026: 7 };
  const periodRows: CurrentYoyPeriodRow[] = [];
  const answerRows: CurrentYoyAnswerRow[] = [];
  for (const year of plan.years) {
    for (const month of monthsOf[year]) {
      periodRows.push({ year, month });
      for (const offense of plan.offenses) {
        answerRows.push({ year, month, offense, offense_count: perCell[year] * GROUP_SIZE });
      }
    }
  }
  const membershipRows: CurrentYoyMembershipRow[] = ["G1", "G2", "G3"].map((ori) => ({ ori }));

  // Expected values computed HERE, independently of the builder.
  const expected: Record<number, number> = {};
  for (const year of plan.years) {
    expected[year] = monthsOf[year].length * plan.offenses.length * perCell[year] * GROUP_SIZE;
  }
  const pct = (now: number, prev: number) => Math.round((1000 * (expected[now] - expected[prev])) / expected[prev]) / 10;
  console.log(`  expected group totals computed here: ${JSON.stringify(expected)}`);

  const group = buildCurrentYoyGroup(plan.years, periodRows, membershipRows, [{ sample_size: STARTING_SAMPLE }], plan.offenses.length);
  check(answerCoversRequiredCells(answerRows, group, plan.offenses),
    "the answer cells cover exactly the required group cells");
  const answer = buildCurrentYoyComparisonAnswer(plan, answerRows, group);
  const row = (year: number) => answer.rows.find((r) => Number(r.year) === year)!;

  // (a) A useful comparison with independently computed totals and percentages.
  check(plan.years.every((y) => Number(row(y).total) === expected[y]),
    "every delivered total equals the independently computed group total");
  check(Number(row(2024).change_pct) === pct(2024, 2023) && Number(row(2025).change_pct) === pct(2025, 2024),
    `the two matched full-year changes are delivered (${pct(2024, 2023)}, ${pct(2025, 2024)})`);

  // (b) The multi-year full/full/partial case: last change withheld, chain refused, totals retained.
  check(row(2026).change_pct === null, "the partial-year change is withheld as null, never zero");
  check(Number(row(2026).prior_year_total) === expected[2025] && Number(row(2026).total) === expected[2026],
    "both group totals for the withheld pair are retained with their year labels");
  check(/does not establish whether violent crime moved in the same direction in every year/.test(answer.explanation),
    "the whole-chain claim is refused");
  check(/2025 covers January-December/.test(answer.explanation) && /2026 covers January-May/.test(answer.explanation),
    "each year's actual months are named");
  check(!/January-May 2025/.test(answer.explanation), "the completed year is not re-cut to match");

  // (c) ONE CLEAR POPULATION. The labels must agree and must not imply the sample or the nation.
  check(new RegExp(`same ${GROUP_SIZE} agencies from a starting sample of ${STARTING_SAMPLE}`).test(answer.explanation),
    `the group size and starting sample are both stated (${GROUP_SIZE}/${STARTING_SAMPLE})`);
  check(new RegExp(`excluded ${STARTING_SAMPLE - GROUP_SIZE} because their records did not include every requested crime`).test(answer.explanation),
    "the excluded count and the reason are stated");
  check(/not all crime in the United States/.test(answer.explanation),
    "the answer says it is not a national figure");
  check(/may differ from totals shown elsewhere for the larger sample/.test(answer.explanation),
    "and warns that it may differ from the larger sample's totals");
  check(!/national sample/i.test(answer.explanation),
    "the explanation never calls the group the national sample");
  check(answer.title === `Violent Crime Counts, Comparison Group of ${GROUP_SIZE} Agencies, 2023-2026`,
    `the title names the comparison group (got ${JSON.stringify(answer.title)})`);
  check(!/National Sample/i.test(answer.title), "and does not say National Sample");
  check(!/\b(?:decreased|increased|fell|rose)\b/i.test(answer.title), "the title asserts no direction");
  check(answer.group.includedCount === GROUP_SIZE && answer.group.excludedCount === STARTING_SAMPLE - GROUP_SIZE,
    "the group is returned with the answer for local evidence");

  // (d) An empty group is an honest limitation with no comparison and no implied population.
  const emptyGroup = buildCurrentYoyGroup(plan.years, periodRows, [], [{ sample_size: STARTING_SAMPLE }], plan.offenses.length);
  const emptyAnswer = buildCurrentYoyComparisonAnswer(plan, [], emptyGroup);
  check(emptyAnswer.rows.every((r) => r.change_pct === null), "an empty group delivers no change values");
  check(/No fixed comparison group could be formed/.test(emptyAnswer.explanation),
    "and says so plainly");
  check(/No Comparison Group Available/.test(emptyAnswer.title), "with a title that agrees");
  check(/does not establish whether violent crime moved in the same direction/.test(emptyAnswer.explanation),
    "and still refuses the whole-chain claim");

  // (e) GC-068's wording: an absent record is not a recorded zero.
  const murderPlan = buildCurrentYoyComparisonPlan("How much did murders increase bv year-over-year from 2019 to 2020")!;
  const mPeriods: CurrentYoyPeriodRow[] = [];
  const mAnswer: CurrentYoyAnswerRow[] = [];
  for (const year of murderPlan.years) {
    for (const month of ALL) {
      mPeriods.push({ year, month });
      mAnswer.push({ year, month, offense: "Murder", offense_count: year === 2019 ? 10 : 20 });
    }
  }
  const mGroup = buildCurrentYoyGroup(murderPlan.years, mPeriods, [{ ori: "M1" }], [{ sample_size: 2 }], 1);
  const mDelivered = buildCurrentYoyComparisonAnswer(murderPlan, mAnswer, mGroup);
  check(Number(mDelivered.rows[1].change_pct) === 100, "a matched full-year pair delivers its change");
  check(/records did not include every requested crime/.test(mDelivered.explanation),
    "exclusion is described as records not included");
  check(!/reported no murders|no murders were reported/i.test(mDelivered.explanation),
    "and never as the agency having reported no murders - an absent record is not a recorded zero");
}

/* ── 14. ordinary answers are untouched ── */
console.log("");
console.log("14 - non-comparison answers are not disturbed");
{
  // A same-row share beside an unrelated lag column: the regression the within-row test exists for.
  const shareSql = "SELECT year, firearm, total, ROUND(100.0*firearm/total,1) AS firearm_pct, " +
    "LAG(total) OVER (ORDER BY year) AS previous_total FROM annual ORDER BY year";
  const shareRows: Record<string, unknown>[] = [
    { year: 2024, firearm: 50, total: 100, firearm_pct: 50, previous_total: null },
    { year: 2025, firearm: 75, total: 150, firearm_pct: 50, previous_total: 100 },
  ];
  const shareOut = withholdUnverifiedChange({
    rows: shareRows, columns: Object.keys(shareRows[0]), sql: shareSql,
    explanation: "Firearm share of murders.", title: "Firearm Share",
    question: "what share of murders involved a firearm by year",
  });
  check(shareOut.withheld.length === 0, "a same-row share is not treated as a change");
  check(JSON.stringify(shareOut.rows) === JSON.stringify(shareRows),
    "and its rows - including `previous_total` - are delivered unchanged");

  // An unchanged total, and an ordinary single-row annual answer.
  const flatRows: Record<string, unknown>[] = [{ year: 2025, total: 100 }, { year: 2026, total: 100 }];
  const flatOut = withholdUnverifiedChange({
    rows: flatRows, columns: ["year", "total"], sql: "SELECT year, SUM(count) AS total FROM t GROUP BY year",
    explanation: "Totals.", title: "Totals", question: "how many murders each year",
  });
  check(flatOut.withheld.length === 0 && JSON.stringify(flatOut.rows) === JSON.stringify(flatRows),
    "an unchanged total is delivered as-is");
  const popRows: Record<string, unknown>[] = [{ year: 2026, population: 115499393 }];
  const popOut = withholdUnverifiedChange({
    rows: popRows, columns: ["year", "population"], sql: "SELECT year, population FROM p WHERE year = 2026",
    explanation: "Population estimate.", title: "Population", question: "What is the population estimate for 2026?",
  });
  check(popOut.withheld.length === 0 && popOut.explanation.includes("Population estimate."),
    "a single-row annual statistic gains no comparison gate");
  check(!/does not establish which months/i.test(popOut.explanation),
    "and no month-coverage warning");
}

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
