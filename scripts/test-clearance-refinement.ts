#!/usr/bin/env npx tsx
/**
 * CAUSE C/D — the explicit clearance refinement, and the floor it must not let through.
 *
 * TWO CHANGES, ONE BATCH, because the first would be unsafe alone.
 *
 *   GC-004  "Which states have the highest share of rapes cleared by exception in 2025?"
 *           then "Now what about just the share that's prosecution declined"
 *
 * The second turn was refused twice on `structural-measure-unit-unmodeled` and delivered the
 * generic second-failure template. The refusal is an artifact of the contract: built from the
 * bare fragment it reads `topic: unknown`, `unit: ratio`, no geography and no period, so a
 * statement that plainly computes a share looks like a share with nothing behind it.
 *
 * RESTORING THE CONTEXT ALONE WOULD BE WORSE THAN THE DEFECT. The saved statement also carries
 * `HAVING SUM(total_offenses) >= 100` — a minimum-count cutoff the reader never asked for, which
 * decides which states can appear in a ranking. Today nothing objects to it, because the only
 * rule of that shape is Historical's population floor. Restoring the context without adding the
 * matching NIBRS protection would turn a refusal into a wrong answer.
 *
 * NOT IN THIS BATCH, and stated so the checks below are not read as more than they are: no
 * generic unknown-topic prefix (it makes "now for 2024" mean 2024–2025 and lets a population
 * question inherit rape-clearance context), no walk through distant history, no conversation
 * engine, and no change to GC-070, GC-058 or GC-048.
 *
 * EVIDENCE BOUNDARY. The history is the RETAINED one: the frozen setup question and the setup
 * turn's own delivered answer, copied from the reviewer's assembly in
 * `audit/phase3-cause-cd-2026-09-25/codex-review/history-and-contract.json`. No assistant text is
 * invented, and the saved SQL is never added to history, because the runner did not send it. The
 * guard below denies file-backed SQLite and the network before any product module loads.
 */

import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";

import { readFileSync } from "fs";

import { resolveClearanceRefinement } from "../lib/clearance-refinement-followup";
import {
  findNibrsClearanceRankingIssues,
  requestedOffenseCountThreshold,
  sqlOffenseCountFloors,
} from "../lib/nibrs-clearance-ranking-request";
import { buildQueryContract } from "../lib/query-contract";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { mayRefuseAsCourtProcess } from "../lib/clearance-referent";
import { extractDeclaration, runRouteExpression } from "./decision1-terminal-harness";
import { resolveNibrsPeriodReplacement } from "../lib/nibrs-request-accounting";
import { resolvePeerCountFollowup } from "../lib/peer-count-followup";
import { resolveRankingExplanationFollowup } from "../lib/nibrs-agency-period-ranking";
import { normalizeHistoryForTab } from "../lib/chat-history";
import { detectFollowupTransform } from "../lib/followup-transform";
import { buildCrossSourceFollowupTransform } from "../lib/cross-source-followup";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  PASS  ${name}${detail ? "   " + detail : ""}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   " + detail : ""}`); }
}

/* ── the retained conversation, not a reconstruction of one ──────────────────────────── */
const REVIEW = JSON.parse(readFileSync(
  "scripts/fixtures/retained-evidence/gc004-history-and-contract.json", "utf8" /* retained input packaged 2026-09-30; source digest and extraction rule in scripts/fixtures/retained-evidence/MANIFEST.json */)) as {
    results: Array<{ id: string; question: string; history: { sent: Array<{ role: string; content: string; source?: string }> } }>;
  };
const GC004 = REVIEW.results.find((r) => r.id === "GC-004")!;
const HISTORY = GC004.history.sent as Array<{ role: string; content: string; source?: string }>;
const SETUP_QUESTION = HISTORY.find((t) => t.role === "user")!.content;
const FOLLOW_UP = GC004.question;

/* ── the saved statement, read from the capture ──────────────────────────────────────── */
const CAPTURE = JSON.parse(readFileSync(
  "scripts/fixtures/retained-evidence/qualification-retained-cases.json", "utf8" /* retained input packaged 2026-09-30; source digest and extraction rule in scripts/fixtures/retained-evidence/MANIFEST.json */)) as {
    cases: Array<{ case: string; scored: { observed: { modelOutputs?: Array<{ text: string }> } } }>;
  };
function savedSql(id: string, index: number): string {
  const raw = (CAPTURE.cases.find((c) => c.case === id)!.scored.observed.modelOutputs ?? [])[index].text;
  return (JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as { sql: string }).sql;
}
/** NEGATIVE CONTROL. The model's own statement, with the cutoff it invented. Never a candidate. */
const SAVED_WITH_FLOOR = savedSql("GC-004", 0);
/** POSITIVE CANDIDATE. A controlled copy written here with the cutoff removed. Not a model output. */
const CONTROLLED_NO_FLOOR = SAVED_WITH_FLOOR.replace(/\s*HAVING\s+SUM\(scd\.total_offenses\)\s*>=\s*100\s*/i, "\n");

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 0 — ISOLATION, AND THE EVIDENCE IS WHAT IT SAYS IT IS
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 0  the guard and the retained history ===");
{
  let denied = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3") as new (f: string) => unknown;
    new Database("nibrs.db");
  } catch { denied = true; }
  check("a file-backed database open is refused in this process", denied);
}
check("the history is the retained conversation: two turns, the setup question and its own answer",
  HISTORY.length === 2 && HISTORY[0].role === "user" && HISTORY[1].role === "assistant"
  && HISTORY[0].content === "Which states have the highest share of rapes cleared by exception in 2025?");
check("no saved SQL is present in the history the application is given",
  !HISTORY.some((t) => /SELECT\s/i.test(t.content)));
check("the two statements differ only by the invented cutoff",
  /HAVING\s+SUM\(scd\.total_offenses\)\s*>=\s*100/i.test(SAVED_WITH_FLOOR)
  && !/HAVING/i.test(CONTROLLED_NO_FLOOR)
  && SAVED_WITH_FLOOR.replace(/\s+/g, " ").replace(/ HAVING SUM\(scd\.total_offenses\) >= 100/i, "")
     === CONTROLLED_NO_FLOOR.replace(/\s+/g, " "));

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 1 — THE REFINEMENT IS RECOGNIZED, AND ONLY WHERE IT APPLIES
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 1  an explicit clearance-reason refinement ===");
{
  const r = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs");
  check("the GC-004 follow-up is recognized as a clearance refinement", Boolean(r),
    r?.refinedQuestion ?? "(null)");
  check("  it names the reason the reader asked for", r?.reason === "prosecution-declined");
  check("  it inherits the prior request's offense, geography and period, and nothing else",
    Boolean(r) && /\brapes?\b/i.test(r!.refinedQuestion) && /\bstates\b/i.test(r!.refinedQuestion)
    && /\b2025\b/.test(r!.refinedQuestion), r?.refinedQuestion);
  check("  and it replaces the prior reason rather than appending to the prior question",
    Boolean(r) && !/cleared by exception/i.test(r!.refinedQuestion)
    && !r!.refinedQuestion.includes(FOLLOW_UP));
}

console.log("\n  the three counterexamples the general prefix would have accepted:");
for (const [q, why] of [
  ["now for 2024", "an explicitly stated new year"],
  ["How many agencies reported in 2024?", "a new agency-count request"],
  ["What is the population of Chicago?", "a standalone population request"],
] as Array<[string, string]>) {
  check(`no refinement — ${why}`, resolveClearanceRefinement(q, HISTORY, "nibrs") === null, `"${q}"`);
}

console.log("\n  the other ways it must decline:");
check("no history, no refinement", resolveClearanceRefinement(FOLLOW_UP, [], "nibrs") === null);
check("an unrelated prior turn does not qualify",
  resolveClearanceRefinement(FOLLOW_UP, [
    { role: "user", content: "how many murders in Chicago in 2023" },
    { role: "assistant", content: "Murders in Chicago, 2023." },
  ], "nibrs") === null);
check("a prior turn from another source does not qualify",
  resolveClearanceRefinement(FOLLOW_UP, [
    { role: "user", content: SETUP_QUESTION, source: "historical" },
    { role: "assistant", content: HISTORY[1].content, source: "historical" },
  ], "nibrs") === null);
check("a follow-up that states its own year does not inherit the prior one",
  resolveClearanceRefinement("what about prosecution declined in 2023", HISTORY, "nibrs") === null);
check("a follow-up that states its own place does not inherit the prior geography",
  resolveClearanceRefinement("prosecution declined in Texas", HISTORY, "nibrs") === null);
check("a follow-up naming no clearance reason is not a refinement",
  resolveClearanceRefinement("now show me the totals", HISTORY, "nibrs") === null);
check("the reader's own threshold is not inherited from the assistant's prose",
  !/at least 100|>= ?100/i.test(resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")?.refinedQuestion ?? ""));

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 2 — WHAT THE CONTRACT THEN SEES
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 2  the contract, before and after ===");
{
  const bare = buildQueryContract(FOLLOW_UP, "nibrs")!;
  check("BEFORE: the bare fragment gives the contract nothing to work with",
    bare.metric.topic === "unknown" && bare.time.startYear === null,
    `${bare.metric.topic}/${bare.metric.unit}`);
  const refined = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!;
  const after = buildQueryContract(refined.refinedQuestion, "nibrs")!;
  check("AFTER: the offense, the measure and the period are restored",
    after.metric.topic === "rape" && after.metric.unit === "clearance_rate"
    && after.time.startYear === 2025 && after.time.endYear === 2025,
    `${after.metric.topic}/${after.metric.unit}/${after.time.startYear}`);
  check("  the offense codes are the prior request's, not invented",
    JSON.stringify(after.metric.offenseCodes) === JSON.stringify(["11A", "11B", "11C"]));

  const beforeValidation = validateQueryContractSql({ question: FOLLOW_UP, source: "nibrs", sql: SAVED_WITH_FLOOR });
  check("BEFORE: the saved statement is refused on the unmodelled-ratio rule",
    beforeValidation.enforced.includes("structural-measure-unit-unmodeled")
    && queryContractFailureMessage(beforeValidation) !== null);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 3 — THE FLOOR THE RESTORATION MUST NOT LET THROUGH
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 3  the unrequested minimum-count cutoff ===");
{
  const refined = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!;
  const q = refined.refinedQuestion;

  check("the request states no minimum count", requestedOffenseCountThreshold(q) === null);
  check("the saved statement imposes one",
    sqlOffenseCountFloors(SAVED_WITH_FLOOR).some((f) => f.operator === ">=" && f.value === 100),
    JSON.stringify(sqlOffenseCountFloors(SAVED_WITH_FLOOR)));
  check("the controlled copy imposes none", sqlOffenseCountFloors(CONTROLLED_NO_FLOOR).length === 0);

  const contract = buildQueryContract(q, "nibrs")!;
  const withFloor = findNibrsClearanceRankingIssues({ question: q, contract, sql: SAVED_WITH_FLOOR });
  const noFloor = findNibrsClearanceRankingIssues({ question: q, contract, sql: CONTROLLED_NO_FLOOR });
  check("NEGATIVE CONTROL: the saved statement is rejected by a named rule",
    withFloor.some((i) => i.ruleId === "nibrs-clearance-ranking-unrequested-offense-floor"),
    withFloor.map((i) => i.ruleId).join(",") || "(nothing fired)");
  check("POSITIVE CANDIDATE: the controlled copy is not", noFloor.length === 0);

  check("a denominator guard is not a cutoff",
    sqlOffenseCountFloors("SELECT SUM(cleared_B)*1.0/NULLIF(SUM(total_offenses),0) FROM summary_clearance_detail WHERE total_offenses > 0").length === 0);
  check("a threshold the reader asked for is theirs to set",
    (() => { const t = requestedOffenseCountThreshold("states with at least 100 reported rapes, share cleared by prosecution declined in 2025");
      return t?.operator === ">=" && t.value === 100; })()
    && findNibrsClearanceRankingIssues({
      question: "which states with at least 100 reported rapes had the highest share cleared because prosecution was declined in 2025",
      contract: buildQueryContract("which states with at least 100 reported rapes had the highest share cleared because prosecution was declined in 2025", "nibrs")!,
      sql: SAVED_WITH_FLOOR,
    }).length === 0);
  check("the rule stays out of the way of a single-place question",
    findNibrsClearanceRankingIssues({
      question: "share of rapes in Texas cleared because prosecution was declined in 2025",
      contract: buildQueryContract("share of rapes in Texas cleared because prosecution was declined in 2025", "nibrs")!,
      sql: SAVED_WITH_FLOOR,
    }).length === 0);
  check("and out of the way of statements that do not read the clearance tables",
    findNibrsClearanceRankingIssues({
      question: q, contract,
      sql: "SELECT state, SUM(offense_count) AS n FROM summary_state_monthly WHERE year = 2025 GROUP BY state HAVING SUM(offense_count) >= 100 ORDER BY n DESC LIMIT 20",
    }).length === 0);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 4 — THE TWO TOGETHER, THROUGH THE REAL VALIDATOR
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 4  restored context and the floor rule, in the same validator ===");
{
  const q = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!.refinedQuestion;
  const saved = validateQueryContractSql({ question: q, source: "nibrs", sql: SAVED_WITH_FLOOR });
  check("the saved statement is STILL refused once the context is restored — on the floor, not the ratio",
    saved.enforced.includes("nibrs-clearance-ranking-unrequested-offense-floor")
    && !saved.enforced.includes("structural-measure-unit-unmodeled")
    && queryContractFailureMessage(saved) !== null,
    JSON.stringify(saved.enforced));

  const controlled = validateQueryContractSql({ question: q, source: "nibrs", sql: CONTROLLED_NO_FLOOR });
  check("the controlled copy passes the whole validator",
    controlled.enforced.length === 0 && controlled.blockReasons.length === 0
    && queryContractFailureMessage(controlled) === null,
    JSON.stringify(controlled.enforced));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 5 — THE ROUTE'S OWN CONTEXT ASSEMBLY, AND DELIVERY
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 5  the NIBRS route's own expression, lifted and run ===");
{
  const decl = extractDeclaration("nibrs", "guardrailQuestion");
  console.log(`    app/api/nibrs-query/route.ts:${decl.line}  ${decl.text.replace(/\s+/g, " ").slice(0, 104)}`);
  const run = (q: string, history: Array<{ role: string; content: string }>) => {
    const normalized = normalizeHistoryForTab(history as never, "nibrs" as never);
    return runRouteExpression<string>(decl.text, {
      plannerMode: "off", followupPlan: null,
      clearanceRefinement: resolveClearanceRefinement(q, history, "nibrs"),
      peerFollowup: resolvePeerCountFollowup(q, history, "nibrs"),
      rankingExplanation: resolveRankingExplanationFollowup(q, history),
      // Stage 3b (plan r1.3): the route's "(just) do it for <year>" resolver, computed as the route computes it.
      periodReplacement: resolveNibrsPeriodReplacement(q, history.filter((h) => h.role === "user").map((h) => h.content)),
      followupTransform: detectFollowupTransform(q, normalized)
        ?? buildCrossSourceFollowupTransform(q, history as never, "nibrs"),
      question: q,
    });
  };
  const carried = run(FOLLOW_UP, HISTORY);
  check("the route's own expression now carries the request forward",
    /\brapes?\b/i.test(carried) && /\b2025\b/.test(carried) && /prosecution/i.test(carried), carried);
  check("an explicit new request is left exactly as the reader wrote it",
    run("What is the population of Chicago?", HISTORY) === "What is the population of Chicago?");
  check("and a first turn is untouched", run(SETUP_QUESTION, []) === SETUP_QUESTION);
}

console.log("\n  delivery of the controlled candidate (FIXTURE EVIDENCE)");
{
  const q = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!.refinedQuestion;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as new (f: string) => {
    exec: (s: string) => void;
    prepare: (s: string) => { run: (...a: unknown[]) => void; all: () => Record<string, unknown>[] };
  };
  const ddl = readFileSync("scripts/fixtures/operation-taxonomy/nibrs.ddl.sql", "utf8");
  const create = ddl.slice(ddl.indexOf("CREATE TABLE summary_clearance_detail"));
  const db = new Database(":memory:");
  db.exec(create.slice(0, create.indexOf(";") + 1));
  const insert = db.prepare(
    "INSERT INTO summary_clearance_detail (year, state, ori, ucr_offense_code, cleared_by_arrest, "
    + "cleared_A, cleared_B, cleared_C, cleared_D, cleared_E, total_offenses) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  // Twenty-five states, ten of them below the invented cutoff and carrying the HIGHEST shares —
  // which is the point of the rule: a minimum count does not trim a ranking's tail, it removes the
  // small places that a question about the highest share is largely asking about.
  for (let i = 0; i < 25; i++) {
    insert.run(2025, `S${i}`, `ORI${i}`, "11A", 5, 1, 20 - (i % 7), 1, 1, 1, i < 10 ? 40 : 300);
  }
  const rows = db.prepare(CONTROLLED_NO_FLOOR).all();
  const withFloorRows = db.prepare(SAVED_WITH_FLOOR).all();
  check("the controlled statement executes against the repository schema", rows.length > 0, `${rows.length} rows`);
  check("the invented cutoff would have removed five places from the delivered ranking",
    rows.length - withFloorRows.length === 5, `${rows.length} vs ${withFloorRows.length}`);
  check("  and it would have changed who came first",
    String(rows[0]?.state) !== String(withFloorRows[0]?.state),
    `${String(rows[0]?.state)} vs ${String(withFloorRows[0]?.state)}`);
  check("the effective offense, reason, year and denominator are the requested ones",
    /ucr_offense_code IN \('11A', '11B', '11C'\)/.test(CONTROLLED_NO_FLOOR)
    && /cleared_B/.test(CONTROLLED_NO_FLOOR) && /year = 2025/.test(CONTROLLED_NO_FLOOR)
    && /NULLIF\(SUM\(scd\.total_offenses\), 0\)/.test(CONTROLLED_NO_FLOOR));

  const delivered = applyResultDisclosures({
    explanation: "States ranked by the share of reported rapes cleared because prosecution was declined in 2025. Showing the top 20 results.",
    question: q, sql: CONTROLLED_NO_FLOOR, rows, tab: "nibrs",
  });
  check("the delivered answer is an answer, not the second-failure template",
    !/couldn't build a reliable query/i.test(delivered) && delivered.length > 0, delivered.slice(0, 56));
  check("and it does not claim a cutoff nobody asked for", !/at least 100/i.test(delivered));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 6 — THE ACCEPTED WORK AND THE OTHER REFUSALS, UNCHANGED
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 6  what must not move ===");
check("Cause A: the restored question is still a police record, not a court refusal",
  !mayRefuseAsCourtProcess(resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!.refinedQuestion)
  && !mayRefuseAsCourtProcess(FOLLOW_UP));
check("Cause A: the court witnesses still refuse",
  mayRefuseAsCourtProcess("conviction rates for murders in Houston")
  && mayRefuseAsCourtProcess("Can you provide the number or percentage of gun prosecutions per year over the last 20 years?"));
{
  const gc058 = "Using 2023 data, which cities in Louisiana had the highest violent crime rate";
  const r = validateQueryContractSql({ question: gc058, source: "historical", sql: savedSql("GC-058", 0) });
  check("GC-058's population floor is still rejected",
    r.enforced.includes("historical-ranking-unrequested-population-floor"), JSON.stringify(r.enforced));
}
{
  const gc048 = "show murders per capita for the city of St. Louis city and the City of Chicago since 1950";
  const r = validateQueryContractSql({ question: gc048, source: "historical", sql: savedSql("GC-048", 1) });
  check("GC-048's second statement is still rejected on lineage",
    r.enforced.includes("structural-returned-series-unresolved"), JSON.stringify(r.enforced));
}
check("GC-070's turn is not a clearance refinement, so its behavior is unchanged",
  resolveClearanceRefinement("now detroit", [
    { role: "user", content: "do for nyc" },
    { role: "assistant", content: "Available year range for New York." },
  ], "current") === null);

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 7 — THE TWO MEANING ERRORS THE REVIEW FOUND
 * ════════════════════════════════════════════════════════════════════════════════════════
 * Both are the review's own witnesses, reproduced here and kept.
 *
 * CD1. My "settles nothing of its own" gate read an UNRECOGNIZED contract as an absent measure.
 * "Now what about the count of prosecutions declined?" has `topic: unknown` only because the
 * parser does not recognize that phrase — and the route turned it into the prior turn's SHARE
 * question. And the prior-phrase match was greedy: `cleared because ...` swallowed the trailing
 * "in 2025", so replacing it dropped the year.
 *
 * CD2. The floor rule compared numbers and discarded operators, so `> 100`, `< 100` and `<= 100`
 * all counted as "the 100 the reader asked for" — three different ranking populations. And the
 * denominator exemption covered every `>`/`>=` at one or less, which quietly exempted `> 1`, a
 * predicate that removes legitimate single-offense places.
 */
console.log("\n=== 7  the measure, the period and the comparator ===");

console.log("\n  CD1: an explicit competing measure is not a share");
for (const [q, why] of [
  ["Now what about the count of prosecutions declined?", "the review's own witness"],
  ["how many prosecutions were declined", "the same request, asked another way"],
  ["what was the total number cleared because prosecution was declined", "a total"],
  ["prosecution declined per capita", "a different denominator"],
] as Array<[string, string]>) {
  check(`no refinement — ${why}`, resolveClearanceRefinement(q, HISTORY, "nibrs") === null, `"${q}"`);
}
{
  const decl = extractDeclaration("nibrs", "guardrailQuestion");
  const raw = "Now what about the count of prosecutions declined?";
  const out = runRouteExpression<string>(decl.text, {
    plannerMode: "off", followupPlan: null,
    clearanceRefinement: resolveClearanceRefinement(raw, HISTORY, "nibrs"),
    peerFollowup: resolvePeerCountFollowup(raw, HISTORY, "nibrs"),
    rankingExplanation: resolveRankingExplanationFollowup(raw, HISTORY),
    periodReplacement: resolveNibrsPeriodReplacement(raw, HISTORY.filter((h) => h.role === "user").map((h) => h.content)),
    followupTransform: detectFollowupTransform(raw, normalizeHistoryForTab(HISTORY as never, "nibrs" as never)),
    question: raw,
  });
  check("  and the route leaves that turn exactly as the reader wrote it", out === raw, out);
}
check("  the supported share refinement still resolves",
  Boolean(resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")));

console.log("\n  CD1: the prior request's period survives a second refinement");
{
  const priorRefined = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!.refinedQuestion;
  const second = resolveClearanceRefinement("Now what about just the share where the offender died", [
    { role: "user", content: priorRefined },
    { role: "assistant", content: "States ranked by that share in 2025." },
  ], "nibrs");
  check("the second refinement resolves", Boolean(second), second?.refinedQuestion ?? "(null)");
  check("  it keeps the year the reader asked for",
    /\b2025\b/.test(second?.refinedQuestion ?? ""), second?.refinedQuestion ?? "(null)");
  check("  and the contract still carries that year",
    buildQueryContract(second?.refinedQuestion ?? "", "nibrs")?.time.startYear === 2025);
  check("  while the reason itself did change",
    /offender died/i.test(second?.refinedQuestion ?? "")
    && !/prosecution was declined/i.test(second?.refinedQuestion ?? ""));
}

console.log("\n  CD2: the comparator is part of the threshold");
{
  const asked = "Which states have the highest share of rapes cleared because prosecution was declined in 2025 among states with at least 100 reported rapes?";
  const contract = buildQueryContract(asked, "nibrs")!;
  const withPredicate = (predicate: string) =>
    SAVED_WITH_FLOOR.replace(/HAVING\s+SUM\(scd\.total_offenses\)\s*>=\s*100/i,
      `HAVING SUM(scd.total_offenses) ${predicate}`);
  const fires = (question: string, predicate: string) =>
    findNibrsClearanceRankingIssues({
      question,
      contract: buildQueryContract(question, "nibrs")!,
      sql: withPredicate(predicate),
    }).length > 0;

  check("the request's own comparator is read, not just its number",
    (() => { const t = requestedOffenseCountThreshold(asked); return t?.operator === ">=" && t.value === 100; })(),
    JSON.stringify(requestedOffenseCountThreshold(asked)));
  check("  >= 100 is what was asked for, and passes", !fires(asked, ">= 100"));
  check("  > 99 is the same set of integers, and passes", !fires(asked, "> 99"));
  check("  > 100 is a different population, and is rejected", fires(asked, "> 100"));
  check("  < 100 is a reversed population, and is rejected", fires(asked, "< 100"));
  check("  <= 100 is a reversed population, and is rejected", fires(asked, "<= 100"));
  void contract;

  const unqualified = resolveClearanceRefinement(FOLLOW_UP, HISTORY, "nibrs")!.refinedQuestion;
  check("on an unqualified request, > 0 is a denominator guard and passes", !fires(unqualified, "> 0"));
  check("  >= 1 is the same guard and passes", !fires(unqualified, ">= 1"));
  check("  > 1 is NOT a denominator guard — it drops single-offense places — and is rejected",
    fires(unqualified, "> 1"));
  check("  >= 2 is rejected as well", fires(unqualified, ">= 2"));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * GC-003 — "…and WHERE had the highest share…": a place ranking that names no level
 * ════════════════════════════════════════════════════════════════════════════════════════
 * The combined checkpoint (2026-09-26) delivered GC-003 with `HAVING SUM(scd.total_offenses) >= 100`
 * and nothing objected: the question names no level, so the requested level read as unknown and the
 * floor rule stepped aside. "Where" asks for places as plainly as "which states" does. The statement
 * below is the one the run delivered, verbatim.
 */
console.log("\n=== GC-003  a place ranking asked with \"where\" ===");
{
  const GC003_Q = "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?";
  const GC003_SQL = "SELECT a.city, a.state, COALESCE(o.offense_name, scd.ucr_offense_code) AS offense_name, SUM(scd.total_offenses) AS total_offenses, SUM(scd.cleared_B) AS cleared_prosecution_declined, ROUND(100.0 * SUM(scd.cleared_B) / NULLIF(SUM(scd.total_offenses), 0), 1) AS pct_prosecution_declined FROM summary_clearance_detail scd JOIN agencies a ON a.ori = scd.ori AND a.year = scd.year LEFT JOIN nibrs_offense_codes o ON o.code = scd.ucr_offense_code WHERE scd.year = 2025 AND a.agency_type = 'City' AND a.population > 0 AND a.city != '' GROUP BY a.city, a.state, scd.ucr_offense_code HAVING SUM(scd.total_offenses) >= 100 ORDER BY pct_prosecution_declined DESC LIMIT 20";
  const issuesFor = (q: string, sql: string) => findNibrsClearanceRankingIssues({ question: q, contract: buildQueryContract(q, "nibrs")!, sql });
  const saved = issuesFor(GC003_Q, GC003_SQL);
  check("the delivered GC-003 statement's invented >= 100 floor is caught",
    saved.length === 1 && saved[0].observed.unrequested === ">= 100", JSON.stringify(saved.map((i) => i.observed)));
  const v = validateQueryContractSql({ question: GC003_Q, source: "nibrs", sql: GC003_SQL });
  check("  and the validator sends it back for a retry, not a refusal",
    v.enforced.includes("nibrs-clearance-ranking-unrequested-offense-floor") && v.retryIssues.length > 0 && v.blockReasons.length === 0,
    JSON.stringify(v.enforced));
  const guarded = GC003_SQL.replace("HAVING SUM(scd.total_offenses) >= 100", "HAVING SUM(scd.total_offenses) > 0");
  check("  CONTROL: the non-zero denominator guard a share needs is kept, and passes", issuesFor(GC003_Q, guarded).length === 0);
  check("  CONTROL: with no HAVING at all (NULLIF guards the division) it passes",
    issuesFor(GC003_Q, GC003_SQL.replace(" HAVING SUM(scd.total_offenses) >= 100", "")).length === 0);
  check("  CONTROL: a floor the reader asked for is theirs to keep",
    issuesFor(`${GC003_Q.replace("?", "")} among places with at least 100 offenses?`, GC003_SQL).length === 0);
  check("  CONTROL: a named level still works as before",
    issuesFor("which states had the highest share of offenses cleared because prosecution was declined in 2025?", GC003_SQL).length === 1);
  check("  CONTROL: a national question with no place in it stays out of scope",
    issuesFor("what crime type had the highest share of offenses cleared because prosecution was declined nationally in 2025?", GC003_SQL).length === 0);
  check("  CONTROL: a relative \"where\" qualifies a measure and asks for no place",
    issuesFor("what crime type had the highest share of offenses cleared where the offender was a juvenile in 2025?", GC003_SQL).length === 0);
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("");
console.log(`  isolation: ${deniedDatabaseOpens().length} file-backed database opens denied, `
  + `${deniedNetworkCalls().length} network calls denied`);
console.log(failures.length === 0
  ? `ALL CHECKS PASSED  (${checks})`
  : `FAILURES: ${failures.length} of ${checks} -> ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
