#!/usr/bin/env npx tsx
/**
 * CAUSE B — the two clarification errors, and the controls that keep them fixed.
 *
 * TWO CORRECTIONS, ONE BATCH, because they are the same subject pointed in opposite directions:
 *
 *   GC-003 "what crime type and where had the highest share of offenses cleared because of
 *          prosecution being declined in 2025?"  — the product ASKED a question the request had
 *          already answered. The crime type is what the user asked FOR.
 *   GC-110 "shootings in Chicago since 2015"     — the product DID NOT ASK a question the request
 *          left open, and answered with fatal shootings. Decision 14 requires resolving the
 *          fatal / nonfatal ambiguity before answering.
 *
 * ASKING LESS IS NOT INTRINSICALLY SAFE. Half the checks here exist to show the questions that
 * must still be asked: a genuinely bare "crime in DC" still asks, and an ambiguous shootings
 * request now asks where it previously answered.
 *
 * EVIDENCE BOUNDARY. Literal questions, fixture rows and controlled model replies written here.
 * The guard below denies file-backed SQLite and the network before any product module loads, so
 * the coverage lines `lib/dynamic-facts.ts` reads at import time fall back to their constants.
 * No provider call, no source database, no rerun, no HTTP request. Where a delivered answer is
 * checked it is FIXTURE EVIDENCE about routing and wording — never a statement about Gemini's
 * performance or about what the real sources hold.
 *
 * ROUTE EVIDENCE, NOT PREDICATE EVIDENCE. A classifier returning false proves only that the
 * classifier changed. Each gate below is also read out of its route with the TypeScript parser
 * and executed — the route's own expression, with the real modules bound.
 */

import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";

import { readFileSync } from "fs";

import {
  classifyCrimeTypeScope,
  shouldAskCrimeType,
  CRIME_TYPE_CLARIFICATION_QUESTION,
} from "../lib/crime-type-clarification";
import {
  classifyShootingScope,
  shouldAskShootingScope,
  answersShootingScopeClarification,
  shootingScopeClarificationAlreadyAsked,
  resolveShootingScopeFollowup,
  SHOOTING_SCOPE_CLARIFICATION_QUESTION,
  ASKS_SHOOTING_WORDING,
  STATES_NONFATAL,
} from "../lib/shooting-scope-clarification";
import { displayPlace, shootingCityIntents, shootingYearIntent, stateMention } from "../lib/shr-deterministic-shooting";
import { shrCountyRequest, resolveShrCountyScope, withShrScopeAndMeasureDisclosures } from "../lib/shr-county-scope";
import { shrRequestedMeasure } from "../lib/shr-murder-licence";
import { explicitStateIntent } from "../lib/explicit-state-intent";
import { sourceYearOverlap } from "../lib/source-year-overlap";
import { buildShrCanonicalLabelCase, resolveShrAgency } from "../lib/shr-place-resolver";
import { appendShrAgencyProbeCaveat, isZeroResult, runShrAgencyProbe } from "../lib/shr-agency-probe";
import { applyChartCustomizations } from "../lib/chart-customization";
import { sealPlanDerivation } from "../lib/plan-derivation";
import { returnedEntityKeys } from "../lib/result-disclosure";
import { normalizeShrAgencyText } from "../lib/shr-agency-normalization";
import { validateDeterministicShrPlanSql } from "../lib/shr-authority";
import { getBlockingGeoClarification } from "../lib/geo-resolver";
import { normalizeHistoryAllSources } from "../lib/chat-history";
import { limitationReply } from "../lib/refusal-safety";
import { classifyShootingQualifier } from "../lib/shooting-qualifiers";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { runGuardrails } from "../lib/guardrails";
import { validateSourceCapabilities } from "../lib/source-capabilities";
import { buildQueryContract } from "../lib/query-contract";
import {
  branchCondition, extractBranch, extractDeclaration, runRouteBranch, runRouteExpression,
} from "./decision1-terminal-harness";

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  PASS  ${name}${detail ? "   " + detail : ""}`);
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   " + detail : ""}`); }
}

/** The frozen questions, copied from docs/superpowers/2026-09-06-correctness-gold-set-v7.json. */
const GC_003 = "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?";
const GC_110 = "shootings in Chicago since 2015";

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 0 — THE ISOLATION IS LIVE
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 0  the offline guard, exercised rather than assumed ===");
{
  let denied = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3") as new (file: string, opts?: unknown) => unknown;
    new Database("shr.db", { readonly: true });
  } catch { denied = true; }
  check("a file-backed database open is refused in this process", denied);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 1 — GC-003: THE QUESTION THAT MUST NOT BE ASKED
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 1  crime-type gate: what the request already chose ===");

const MUST_NOT_ASK: Array<[string, string]> = [
  [GC_003, "the frozen GC-003 wording"],
  ["what crime type had the highest share of offenses cleared in 2025?", "what + cleared"],
  ["which crime type had the highest share of offenses cleared in 2025?", "which + cleared"],
  ["what crime type had the highest clearance share in 2025?", "what + clearance"],
  ["which crime category was cleared most often in Ohio", "category + cleared"],
  ["what type of crime had the most clearances in 2025", "type of crime + clearances"],
  ["what offense type had the highest share of exceptional clearances", "offense type"],
  // These two discriminate between the halves of the repair. GC-003's own wording is carried by
  // either change on its own, so without them a mutation that removed one would stay green.
  ["what crime type is most common in Mesa", "the type-as-output rule alone"],
  ["how much crime was cleared in DC", "the cleared-stem rule alone"],
  ["What is the most prevalent crime in Lewis County, Missouri?", "GC-075"],
  ["total crime last 10 years broken down by vilont vs nonvilont", "GC-076"],
  ["violent crime in DC", "an explicit category"],
  ["property crime in Mesa", "an explicit category"],
  ["both crimes in Portland", "both, explicitly"],
  ["murders in Houston since 2010", "a specific offense"],
];
for (const [q, why] of MUST_NOT_ASK) {
  check(`no clarification — ${why}`, !classifyCrimeTypeScope(q).needsClarification,
    `"${q.slice(0, 52)}"`);
}

const MUST_STILL_ASK: Array<[string, string]> = [
  ["crime in DC", "the bare word, the case the gate exists for"],
  ["crime trends in Charlotte", "the bare word with a trend"],
  ["how much crime is there in Baltimore", "the bare word, asked another way"],
  ["tell me about crime in Salem Oregon", "the bare word, asked another way"],
  ["what was the crime rate in Mesa in 2024", "a rate of unchosen crime"],
];
for (const [q, why] of MUST_STILL_ASK) {
  const d = classifyCrimeTypeScope(q);
  check(`still asks — ${why}`, d.needsClarification && d.clarificationQuestion === CRIME_TYPE_CLARIFICATION_QUESTION,
    `"${q}"`);
}

console.log("\n  conversation behavior is unchanged:");
check("an answer to the clarification does not re-ask", !shouldAskCrimeType("violent").needsClarification);
check("the clarification is asked once, not in a loop",
  !shouldAskCrimeType("crime in DC", [{ role: "assistant", content: CRIME_TYPE_CLARIFICATION_QUESTION }]).needsClarification);
check("an unrelated assistant turn does not count as having asked",
  shouldAskCrimeType("crime in DC", [{ role: "assistant", content: "Murders rose." }]).needsClarification);
check("the gate stays crime-TYPE only: a question with no crime word is untouched",
  !classifyCrimeTypeScope("how many officers does Mesa employ").needsClarification);

/* ── the route's own gate, lifted and executed ───────────────────────────────────────── */
console.log("\n  the NIBRS route's own expression, lifted with the parser and run:");
{
  const decl = extractDeclaration("nibrs", "crimeTypeAsk");
  console.log(`    ${decl.file}:${decl.line}  ${decl.text.replace(/\s+/g, " ").slice(0, 96)}`);
  const run = (q: string, history: Array<{ role: string; content: string }> = []) =>
    runRouteExpression<{ needsClarification: boolean } | null>(decl.text, {
      getBlockingGeoClarification,
      shouldAskCrimeType,
      normalizeHistoryAllSources,
      crimeTypeQuestion: q,
      body: { history },
    });
  check("the route gate no longer stops GC-003", run(GC_003)?.needsClarification === false);
  check("the route gate still stops a bare crime question", run("crime in DC")?.needsClarification === true);
  check("geographic precedence is preserved: an ambiguous place yields null, not a crime question",
    run("crime in Kansas City") === null);

  const exit = extractBranch("nibrs", {
    condStartsWith: "crimeTypeAsk?.needsClarification",
    mustInclude: "crime-type:violent-property-both",
  });
  check("the clarification exit is still the route's own, and still terminal",
    /\breturn\b/.test(exit.text) && exit.text.includes("crime-type:violent-property-both"),
    `${exit.file}:${exit.line}`);

  // The branch's own condition, executed. Reading the body and running the declaration that
  // feeds it says nothing about whether the branch is ever REACHED.
  const entered = (q: string) => runRouteExpression<boolean>(branchCondition(exit), {
    crimeTypeAsk: run(q),
  });
  check("the exit is not entered for GC-003", entered(GC_003) === false);
  check("the exit IS still entered for a bare crime question", entered("crime in DC") === true);
}

/* ── beyond the former exit: a controlled valid reply, carried to delivery ────────────── */
console.log("\n  past the gate: a controlled police-clearance reply, EXECUTED (FIXTURE EVIDENCE)");
{
  /*
   * WHAT THE FIRST VERSION OF THIS BLOCK DID WRONG (Codex review B2). It wrote a controlled SQL
   * string, fabricated twenty rows beside it, and called the capability, guardrail and disclosure
   * helpers on both. The SQL selected `cleared_B` from `summary_clearance_type`, which has no such
   * column — that reason-specific column lives in `summary_clearance_detail`. The statement could
   * never have prepared, and nothing in the block would have noticed, because no database was
   * involved at any point. "A valid reply survives the delivery path" was not shown.
   *
   * So the statement is now PREPARED AND EXECUTED against the repository's own NIBRS schema
   * fixture, in memory, and the rows below are what that execution returned rather than what I
   * typed. It remains fixture evidence about the delivery path: the numbers are seeded here and
   * say nothing about the real source, and no model produced this statement.
   */
  const ddl = readFileSync("scripts/fixtures/operation-taxonomy/nibrs.ddl.sql", "utf8");
  const createTable = (name: string) => {
    const from = ddl.slice(ddl.indexOf(`CREATE TABLE ${name}`));
    return from.slice(0, from.indexOf(";") + 1);
  };
  // BOTH clearance tables, so the control below fails on the missing COLUMN rather than on a
  // missing table — which is the error the review actually reproduced.
  const createStatement = createTable("summary_clearance_detail");
  const createTypeTable = createTable("summary_clearance_type");
  check("the fixture schema is the repository's own, not retyped here",
    /CREATE TABLE summary_clearance_detail/.test(createStatement) && /\bcleared_B\b/.test(createStatement)
    && /CREATE TABLE summary_clearance_type/.test(createTypeTable) && !/\bcleared_B\b/.test(createTypeTable));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as new (file: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: () => Record<string, unknown>[]; run: (...a: unknown[]) => void };
    close: () => void;
  };
  const db = new Database(":memory:");
  db.exec(createStatement);
  db.exec(createTypeTable);
  // Twenty-five (offense, state) groups, so a LIMIT of 20 has something to cut.
  const insert = db.prepare(
    "INSERT INTO summary_clearance_detail (year, state, ori, ucr_offense_code, cleared_by_arrest, "
    + "cleared_A, cleared_B, cleared_C, cleared_D, cleared_E, total_offenses) "
    + "VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 25; i++) {
    insert.run(2025, `S${i % 5}`, `ORI${i}`, `${200 + i}`, 10, 1, 25 - i, 1, 1, 1, 100);
  }

  const controlledSql =
    "SELECT ucr_offense_code, state, SUM(cleared_B) * 1.0 / SUM(total_offenses) AS declined_share "
    + "FROM summary_clearance_detail WHERE year = 2025 GROUP BY ucr_offense_code, state "
    + "ORDER BY declined_share DESC LIMIT 20";

  // The defect this block used to have, kept as a control: the old statement must still fail.
  let oldStatementError = "";
  try { db.prepare(controlledSql.replace("summary_clearance_detail", "summary_clearance_type")).all(); }
  catch (err) { oldStatementError = err instanceof Error ? err.message : String(err); }
  check("the previously submitted statement does NOT prepare against the real schema",
    /no such (?:table|column)/i.test(oldStatementError), oldStatementError || "(it prepared)");

  const controlledRows = db.prepare(controlledSql).all();
  db.close();

  check("the corrected statement executes against the real schema", controlledRows.length > 0);
  check("the controlled reply carries an explicit LIMIT 20", /\bLIMIT\s+20\b/i.test(controlledSql));
  check("EXECUTION returns no more than twenty rows", controlledRows.length <= 20,
    `${controlledRows.length} rows from 25 seeded groups`);
  check("it applies no unsolicited eligibility floor",
    !/\bHAVING\b/i.test(controlledSql) && !/\bpopulation\s*>/i.test(controlledSql)
    && !/total_offenses\s*>=?\s*\d/i.test(controlledSql));
  check("its scope is the whole question — offense type AND place",
    Object.keys(controlledRows[0] ?? {}).includes("ucr_offense_code")
    && Object.keys(controlledRows[0] ?? {}).includes("state"));

  const contract = buildQueryContract(GC_003, "nibrs");
  const findings = contract
    ? validateSourceCapabilities({ question: GC_003, source: "nibrs", contract, sql: controlledSql })
    : [];
  const blocked = findings.filter((f) => f.severity === "unsupported");
  check("no capability rule refuses the request once it reaches the model path",
    blocked.length === 0, blocked.map((f) => f.ruleId).join(",") || "(none)");

  const guard = runGuardrails({ question: GC_003, sql: controlledSql, tab: "nibrs" } as never) as unknown as
    { fired?: string[]; overrideResponse?: string | null };
  check("the guardrail pipeline does not override the delivered answer",
    !guard.overrideResponse, JSON.stringify(guard.fired ?? []).slice(0, 60));

  const delivered = applyResultDisclosures({
    explanation: "The highest share of offenses cleared because prosecution was declined, by offense type and state, for 2025. Showing the top 20 results.",
    question: GC_003, sql: controlledSql, rows: controlledRows, tab: "nibrs",
  });
  check("the delivered answer states the row limit", /\btop 20\b/i.test(delivered));
  check("the delivered answer is an answer, not a clarification and not a refusal",
    !delivered.includes(CRIME_TYPE_CLARIFICATION_QUESTION)
    && !/restate it with the place, offense, and date range/i.test(delivered),
    delivered.slice(0, 58));
  console.log("    NOTE: reaching the model is not recovery. Whether the model emits LIMIT 20 for");
  console.log("          GC-003 on NIBRS is not shown here and was never captured — the run stopped");
  console.log("          at the gate with zero calls.");
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 2 — GC-110: THE QUESTION THAT MUST BE ASKED
 * ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n=== 2  shooting scope: fatal or nonfatal, asked before answering ===");

check("the frozen ambiguous request asks", classifyShootingScope(GC_110).needsClarification);
check("and the question it asks names both readings",
  /fatal/i.test(SHOOTING_SCOPE_CLARIFICATION_QUESTION) && /survive|nonfatal/i.test(SHOOTING_SCOPE_CLARIFICATION_QUESTION),
  SHOOTING_SCOPE_CLARIFICATION_QUESTION.slice(0, 70));

const SCOPE_STATED: Array<[string, string]> = [
  ["fatal shootings in Chicago since 2015", "fatal, stated"],
  ["nonfatal shootings in Chicago since 2015", "nonfatal, stated"],
  ["non-fatal shootings in Chicago since 2015", "nonfatal, hyphenated"],
  ["firearm homicides in Chicago since 2015", "firearm homicides"],
  ["aggravated assaults with a firearm in Chicago", "the broader measure, named"],
  ["murders in Chicago since 2015", "not a shootings question at all"],
];
for (const [q, why] of SCOPE_STATED) {
  check(`no clarification — ${why}`, !classifyShootingScope(q).needsClarification, `"${q}"`);
}
check("an ambiguous request with a qualifier still asks",
  classifyShootingScope("police shootings in Chicago since 2015").needsClarification);
check("fatal is never inferred from the absence of a nonfatal word",
  classifyShootingScope("shootings in Chicago since 2015").scope === "unspecified");

console.log("\n  answering the question, and carrying the request forward:");
check("a bare fatal answer is recognized", answersShootingScopeClarification("fatal") === "fatal");
check("a bare nonfatal answer is recognized", answersShootingScopeClarification("non-fatal") === "nonfatal");
check("an unrelated turn is not an answer", answersShootingScopeClarification("what about Houston") === null);

const ASKED_HISTORY = [
  { role: "user", content: GC_110 },
  { role: "assistant", content: SHOOTING_SCOPE_CLARIFICATION_QUESTION },
];
{
  const fatal = resolveShootingScopeFollowup("fatal", ASKED_HISTORY);
  check("the fatal answer carries Chicago and since 2015 forward",
    fatal?.scope === "fatal" && /\bChicago\b/.test(fatal.reconstructedQuestion)
    && /since 2015/.test(fatal.reconstructedQuestion), fatal?.reconstructedQuestion ?? "(null)");
  check("and the reconstructed request no longer asks the question again",
    Boolean(fatal) && !classifyShootingScope(fatal!.reconstructedQuestion).needsClarification);

  const nonfatal = resolveShootingScopeFollowup("nonfatal please", ASKED_HISTORY);
  check("the nonfatal answer carries the same request forward",
    nonfatal?.scope === "nonfatal" && /\bChicago\b/.test(nonfatal.reconstructedQuestion)
    && /since 2015/.test(nonfatal.reconstructedQuestion), nonfatal?.reconstructedQuestion ?? "(null)");
  check("and it reaches the existing capability limitation, not a fatal count",
    Boolean(nonfatal)
    && limitationReply(nonfatal!.reconstructedQuestion, "shr").reason === "nonfatal-shooting-scope"
    && limitationReply(nonfatal!.reconstructedQuestion, "shr").rows.length === 0);

  check("scope is never inherited from the mere existence of history",
    resolveShootingScopeFollowup("fatal", [
      { role: "user", content: GC_110 },
      { role: "assistant", content: "Fatal shootings by year in Chicago." },
    ]) === null);
  check("and a turn that does not answer the question inherits nothing",
    resolveShootingScopeFollowup("what about Houston", ASKED_HISTORY) === null);
  check("the gate does not re-ask once it has been answered",
    !shouldAskShootingScope("fatal", ASKED_HISTORY).needsClarification);
}

console.log("\n  supported and unsupported qualifier handling is preserved:");
check("a supported qualifier is still supported",
  classifyShootingQualifier("police fatal shootings in 2023").kind === "supported");
check("an unsupported qualifier is still unsupported",
  classifyShootingQualifier("gang related fatal shootings in 2023").kind === "unsupported");

/* ── the route's own gate, lifted and executed ───────────────────────────────────────── */
console.log("\n  the SHR route's own expressions, lifted with the parser and run:");
{
  const askDecl = extractDeclaration("shr", "shootingScopeAsk");
  const reqDecl = extractDeclaration("shr", "shootingRequest");
  console.log(`    ${askDecl.file}:${askDecl.line}  ${askDecl.text.replace(/\s+/g, " ").slice(0, 92)}`);
  console.log(`    ${reqDecl.file}:${reqDecl.line}  ${reqDecl.text.replace(/\s+/g, " ").slice(0, 92)}`);

  const runAsk = (q: string, history: Array<{ role: string; content: string }> = []) =>
    runRouteExpression<{ needsClarification: boolean }>(askDecl.text, {
      shouldAskShootingScope, normalizeHistoryAllSources,
      shootingRequest: q, body: { history },
    });
  const runRequest = (q: string, history: Array<{ role: string; content: string }> = []) =>
    runRouteExpression<string>(reqDecl.text, {
      shootingScopeFollowup: resolveShootingScopeFollowup(q, normalizeHistoryAllSources(history)),
      question: q,
    });

  check("the route asks on the frozen ambiguous request", runAsk(GC_110).needsClarification === true);
  check("the route does not ask when the request states fatal",
    runAsk("fatal shootings in Chicago since 2015").needsClarification === false);
  check("the route does not ask when the request states nonfatal",
    runAsk("nonfatal shootings in Chicago since 2015").needsClarification === false);

  const carried = runRequest("fatal", ASKED_HISTORY);
  check("the route's own reconstruction carries the request forward",
    /\bChicago\b/.test(carried) && /since 2015/.test(carried) && /\bfatal\b/i.test(carried), carried);
  check("and an ordinary turn is left exactly as the user wrote it",
    runRequest(GC_110, []) === GC_110);

  const exit = extractBranch("shr", {
    condStartsWith: "asksShooting&&!wantsNonfatal&&shootingScopeAsk",
    mustInclude: "shooting-scope-clarification",
  });
  console.log(`    ${exit.file}:${exit.line}  the clarification exit`);

  // The branch's own condition, executed with the route's own `asksShooting`, `wantsNonfatal`
  // and `shootingScopeAsk` declarations. `asksCityFirearmHomicideTrend` is supplied as false —
  // it is this route's separate firearm-trend intent signal and resolving it would open the SHR
  // database, which this suite denies.
  const asksDecl = extractDeclaration("shr", "asksShooting");
  const nonfatalDecl = extractDeclaration("shr", "wantsNonfatal");
  const cond = branchCondition(exit);
  const entered = (q: string, history: Array<{ role: string; content: string }> = []) => {
    const ask = runRouteExpression<{ needsClarification: boolean }>(askDecl.text, {
      shouldAskShootingScope, normalizeHistoryAllSources, shootingRequest: q, body: { history },
    });
    return runRouteExpression<boolean>(cond, {
      asksShooting: runRouteExpression<boolean>(asksDecl.text, {
        ASKS_SHOOTING_WORDING, shootingRequest: q, asksCityFirearmHomicideTrend: false,
      }),
      wantsNonfatal: runRouteExpression<boolean>(nonfatalDecl.text, { STATES_NONFATAL, shootingRequest: q }),
      shootingScopeAsk: ask,
      plannerMode: "authoritative",
      followupPlan: null,
    });
  };
  check("the exit IS entered for the frozen ambiguous request", entered(GC_110) === true);
  check("the exit is NOT entered once the request states fatal",
    entered("fatal shootings in Chicago since 2015") === false);
  check("the exit is NOT entered once the request states nonfatal",
    entered("nonfatal shootings in Chicago since 2015") === false);
  check("the exit is NOT entered for a question that is not about shootings",
    entered("murders in Chicago since 2015") === false);

  check("the clarification exit is terminal", /\breturn\b/.test(exit.text));
  check("it delivers no statement and no rows",
    /sql:\s*null/.test(exit.text) && /rows:\s*\[\]/.test(exit.text) && /rowCount:\s*0/.test(exit.text));
  check("it dispatches no model call",
    !/translateToSql|translate\(/.test(exit.text));

  // Ordering: geography first, then crime type, then shooting scope — one question per turn.
  const shrSrc = readFileSync("app/api/shr-query/route.ts", "utf8").split("\n");
  const lineOf = (needle: string) => shrSrc.findIndex((l) => l.includes(needle)) + 1;
  const geoLine = lineOf("if (geoClarification)");
  const crimeTypeLine = lineOf("if (crimeTypeAsk?.needsClarification)");
  check("geographic clarification still comes first",
    geoLine > 0 && geoLine < exit.line, `geo ${geoLine} < scope ${exit.line}`);
  check("the crime-type question still comes before the shooting-scope question",
    crimeTypeLine > 0 && crimeTypeLine < exit.line, `crime-type ${crimeTypeLine} < scope ${exit.line}`);

  const deterministicLine = lineOf("asksShooting && !wantsNonfatal && shootingQualifier.kind !== \"unsupported\"");
  check("and the question is asked BEFORE the deterministic fatal answer could be produced",
    deterministicLine > 0 && exit.line < deterministicLine, `scope ${exit.line} < fatal path ${deterministicLine}`);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 3 — B1: A PREVIOUS QUESTION IS NOT AN ANSWER
 * ════════════════════════════════════════════════════════════════════════════════════════
 * The first version of `shouldAskShootingScope` suppressed the question whenever it had already
 * been asked, whether or not anyone answered. So the second turn of an ordinary conversation —
 * repeat the request, or ask the same thing about another city — fell through to the
 * deterministic fatal path and got a number. The witnesses are the review's own.
 */
console.log("\n=== 3  the pending choice: unanswered means unresolved ===");

const ASKED_ONLY = [
  { role: "user", content: GC_110 },
  { role: "assistant", content: SHOOTING_SCOPE_CLARIFICATION_QUESTION },
];
const PENDING: Array<[string, string]> = [
  [GC_110, "the same request, repeated"],
  ["shootings in Houston since 2018", "the same ambiguity about another city"],
  ["how many shootings were there in Chicago in 2019", "a third ambiguous phrasing"],
];
for (const [q, why] of PENDING) {
  const d = shouldAskShootingScope(q, ASKED_ONLY);
  check(`still asks after an unanswered question — ${why}`,
    d.needsClarification && d.scope === "unspecified", `"${q}"`);
}
check("the reminder says the choice is pending rather than claiming it was settled",
  /pending/i.test(shouldAskShootingScope(GC_110, ASKED_ONLY).reason));
check("an explicit answer still resolves it, and only an explicit answer does",
  !shouldAskShootingScope("fatal shootings in Chicago since 2015", ASKED_ONLY).needsClarification
  && resolveShootingScopeFollowup(GC_110, ASKED_ONLY) === null);
check("a new ambiguous request is not given the old place and period",
  resolveShootingScopeFollowup("shootings in Houston since 2018", ASKED_ONLY) === null);

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 4 — THE ROUTE BODIES, EXECUTED
 * ════════════════════════════════════════════════════════════════════════════════════════
 * A regular expression over a branch cannot tell you what it delivers. These run the route's
 * own statements with the database replaced by an in-memory fixture built from the repository's
 * own SHR schema, and a provider stub that counts every dispatch.
 */
async function main(): Promise<void> {
console.log("\n=== 4  the route's own bodies, executed against a fixture ===");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3") as new (file: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...a: unknown[]) => void; get: () => unknown; all: (...a: unknown[]) => unknown[] };
};
const shrDb = new Database(":memory:");
shrDb.exec(readFileSync("scripts/fixtures/operation-taxonomy/shr.ddl.sql", "utf8"));
shrDb.prepare("INSERT INTO shr_agency_identity VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ILCPD00", "IL", "Chicago", "City", "CHICAGO", "Chicago", "City", null, null, 500, 1976, 2026);
shrDb.prepare("INSERT INTO shr_agency_alias VALUES (?,?,?,?,?,?,?)")
  .run("Chicago", "CHICAGO", "ILCPD00", "IL", "Chicago", "City", "fixture");
{
  const incident = shrDb.prepare("INSERT INTO incidents (id, year, month, state, ori, agency, homicide_type, weapon_group, agency_type) VALUES (?,?,?,?,?,?,?,?,?)");
  const victim = shrDb.prepare("INSERT INTO victims (id, incident_id, victim_num) VALUES (?,?,?)");
  let id = 1;
  for (let year = 2015; year <= 2020; year++) {
    for (let k = 0; k < year - 2013; k++) {
      incident.run(id, year, 6, "IL", "ILCPD00", "Chicago", "Murder", "Firearm", "City");
      victim.run(id, id, 1);
      id++;
    }
  }
}
check("the SHR fixture is the repository's own schema, seeded in memory",
  (shrDb.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n === 27);

/** Everything the executed statements were given, and everything they did with it. */
function harness(request: string, userTurn: string) {
  const dispatches: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const logged: unknown[][] = [];
  const runValidation = runRouteExpression<(sql: string) => unknown>(
    extractDeclaration("shr", "runDeterministicPlanValidation").text,
    // GC-080: the closure now passes the bound county scope; these fixtures name no county.
    { validateDeterministicShrPlanSql, guardrailQuestion: request, routingMeta: null, recordContractValidation: () => {}, shrCountyScope: null });
  return {
    dispatches, payloads, logged,
    catalog: {
      // the real decisions
      shootingRequest: request,
      shootingQualifier: classifyShootingQualifier(request),
      asksShooting: ASKS_SHOOTING_WORDING.test(request),
      wantsNonfatal: STATES_NONFATAL.test(request),
      shootingScopeAsk: shouldAskShootingScope(request, []),
      shootingYearIntent, sourceYearOverlap, shootingCityIntents, displayPlace, stateMention,
      explicitStateIntent, resolveShrAgency, buildShrCanonicalLabelCase,
      isZeroResult, runShrAgencyProbe, appendShrAgencyProbeCaveat,
      applyChartCustomizations, sealPlanDerivation, returnedEntityKeys, normalizeShrAgencyText,
      limitationReply,
      runDeterministicPlanValidation: runValidation,
      // GC-080: the county-to-sheriff scope and the request-selected measure the branch now reads.
      shrRequestedMeasure, shrCountyRequest, resolveShrCountyScope, withShrScopeAndMeasureDisclosures,
      guardrailQuestion: request,
      shrCountyScope: null,
      countyScopeExit: () => null,
      // supplied, and said so: route-local helpers and transport
      contractFailureResponse: () => null,
      countyIntent: () => null,
      ambiguousKansasCityIntent: () => false,
      normalizeShrDisplayRows: (rows: unknown) => rows,
      plannerMode: "authoritative", followupPlan: null,
      question: userTurn, start: Date.now(), sessionId: "fixture",
      getShrDb: () => shrDb,
      serializeChartConfigForLog: () => null,
      attachChartAuditToPayload: (p: unknown) => p,
      chartAuditRequestId: "fixture", chartAuditQueryLogId: null,
      finalizeExit: (o: Record<string, unknown>) => ({ proof: o }),
      writeLog: (...args: unknown[]) => { logged.push(args); return 1; },
      jsonResp: (p: unknown) => p,
      emitFactualPayload: (_proof: unknown, payload: Record<string, unknown>) => { payloads.push(payload); return payload; },
      // every provider entry point the branch could reach, counting dispatches
      translateToSql: async () => { dispatches.push("translateToSql"); return { sql: null, explanation: "" }; },
      translate: async () => { dispatches.push("translate"); return { sql: null, explanation: "" }; },
    } as Record<string, unknown>,
  };
}

const clarifyExit = extractBranch("shr", {
  condStartsWith: "asksShooting&&!wantsNonfatal&&shootingScopeAsk",
  mustInclude: "shooting-scope-clarification",
});
const nonfatalExit = extractBranch("shr", {
  condStartsWith: "asksShooting&&wantsNonfatal",
  mustInclude: "nonfatal-shooting-capability-limit",
});
const fatalBranch = extractBranch("shr", {
  condStartsWith: "asksShooting&&!wantsNonfatal&&shootingQualifier",
  mustInclude: "plannedShootingSql",
});
console.log(`    clarify ${clarifyExit.line} | nonfatal ${nonfatalExit.line} | fatal ${fatalBranch.line}`);

/* ── the clarification, executed ──────────────────────────────────────────────────────── */
{
  const h = harness(GC_110, GC_110);
  const out = await runRouteBranch(clarifyExit.text, h.catalog);
  const payload = h.payloads[0] ?? {};
  check("the ambiguous request is handled by the clarification exit", out.returned);
  check("  it delivers the question and nothing else",
    payload.explanation === SHOOTING_SCOPE_CLARIFICATION_QUESTION
    && payload.sql === null && Array.isArray(payload.rows) && (payload.rows as unknown[]).length === 0
    && payload.rowCount === 0,
    String(payload.explanation ?? "").slice(0, 50));
  check("  no model call is dispatched", h.dispatches.length === 0, `${h.dispatches.length} dispatches`);
  check("  and the turn is logged as the shooting-scope clarification",
    h.logged.some((args) => args.some((a) => Array.isArray(a) && (a as string[]).includes("shooting-scope-clarification"))));
}

/* ── the explicit nonfatal continuation, executed ─────────────────────────────────────── */
{
  const carried = resolveShootingScopeFollowup("nonfatal", ASKED_HISTORY)!;
  const h = harness(carried.reconstructedQuestion, "nonfatal");
  const out = await runRouteBranch(nonfatalExit.text, h.catalog);
  const payload = h.payloads[0] ?? {};
  check("answering nonfatal reaches the existing capability limitation", out.returned);
  check("  it carries Chicago and since 2015 into the request that was answered",
    /\bChicago\b/.test(carried.reconstructedQuestion) && /since 2015/.test(carried.reconstructedQuestion),
    carried.reconstructedQuestion);
  check("  the reader is told what is not collected, with no rows and no statement",
    /Nonfatal shootings are not collected here/.test(String(payload.explanation ?? ""))
    && payload.sql === null && (payload.rows as unknown[]).length === 0);
  check("  no fatal count is substituted", !/fatal_shootings/.test(JSON.stringify(payload.rows ?? [])));
  check("  no model call is dispatched", h.dispatches.length === 0);
}

/* ── the explicit fatal continuation, executed to delivery ────────────────────────────── */
{
  const carried = resolveShootingScopeFollowup("fatal", ASKED_HISTORY)!;
  const h = harness(carried.reconstructedQuestion, "fatal");
  const out = await runRouteBranch(fatalBranch.text, h.catalog);
  const payload = h.payloads[0] ?? {};
  const sql = String(payload.sql ?? "");
  const rows = (payload.rows ?? []) as Array<Record<string, unknown>>;
  console.log(`    question "fatal" -> request "${carried.reconstructedQuestion}"`);
  console.log(`    sql: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(`    rows: ${JSON.stringify(rows).slice(0, 110)}`);
  check("answering fatal reaches the deterministic fatal path and delivers", out.returned);
  check("  the statement is scoped to the agency the request named",
    /ILCPD00/.test(sql) && /homicide_type = 'Murder'/.test(sql) && /weapon_group = 'Firearm'/.test(sql));
  check("  and to the period the request named, not to a bare word",
    /i\.year >= 2015/.test(sql), (/i\.year >= \d{4}/.exec(sql) ?? ["(no year predicate)"])[0]);
  check("  rows come back from executing it, one per year",
    rows.length === 6 && rows.every((r) => typeof r.fatal_shootings === "number"), `${rows.length} rows`);
  check("  the delivered explanation names the measure and the place",
    /fatal shootings \(firearm homicides\)/i.test(String(payload.explanation ?? ""))
    && /Chicago/.test(String(payload.explanation ?? "")));
  check("  no model call is dispatched on the deterministic path", h.dispatches.length === 0);
}

/* ── B1: what the broken behavior did, executed ───────────────────────────────────────── */
{
  // The old rule, restated here so the defect can be run rather than described: a question that
  // was asked counted as a question that was answered.
  const brokenAsk = (q: string, history: Array<{ role: string; content: string }>) => {
    const d = shouldAskShootingScope(q, history);
    return shootingScopeClarificationAlreadyAsked(history)
      ? { ...d, needsClarification: false, clarificationQuestion: "" }
      : d;
  };
  const cond = branchCondition(clarifyExit);
  const enters = (ask: { needsClarification: boolean }) => runRouteExpression<boolean>(cond, {
    asksShooting: true, wantsNonfatal: false, shootingScopeAsk: ask,
    plannerMode: "authoritative", followupPlan: null,
  });
  check("BROKEN: the repeated ambiguous request did not reach the clarification",
    enters(brokenAsk(GC_110, ASKED_ONLY)) === false);
  check("FIXED: it does now", enters(shouldAskShootingScope(GC_110, ASKED_ONLY)) === true);

  // And under the old rule it did not merely skip a question — it delivered a number.
  const h = harness(GC_110, GC_110);
  const out = await runRouteBranch(fatalBranch.text, h.catalog);
  const rows = (h.payloads[0]?.rows ?? []) as unknown[];
  check("BROKEN: the unanswered request would have been answered with fatal counts",
    out.returned && rows.length > 0, `${rows.length} rows delivered for an unanswered choice`);
  check("FIXED: that turn is now handled by the clarification exit first, which returns",
    (await runRouteBranch(clarifyExit.text, {
      ...h.catalog, shootingScopeAsk: shouldAskShootingScope(GC_110, ASKED_ONLY),
    })).returned);
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 5 — LIMITS OF THE HELPER, RECORDED RATHER THAN CLAIMED AWAY
 * ════════════════════════════════════════════════════════════════════════════════════════
 * My submission said every bare shootings form now asks. It does not, and these two are why.
 * Both are PRE-EXISTING wording behaviors, not defects introduced here and not repaired here;
 * they are pinned so the claim cannot quietly widen again.
 */
console.log("\n=== 5  what this helper does NOT cover ===");
check("\"gun violence\" is not covered: the guidance rule that fires for it has a different id",
  !classifyShootingScope("gun violence in Chicago since 2015").needsClarification
  && classifyShootingScope("gun violence in Chicago since 2015").scope === "stated");
check("\"people shot\" is read as explicit nonfatal by the carried legacy pattern, so it does not ask",
  !classifyShootingScope("people shot in Chicago since 2015").needsClarification
  && STATES_NONFATAL.test("people shot in Chicago since 2015"));

/* ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("");
console.log(`  isolation: ${deniedDatabaseOpens().length} file-backed database opens denied, `
  + `${deniedNetworkCalls().length} network calls denied`);
console.log(failures.length === 0
  ? `ALL CHECKS PASSED  (${checks})`
  : `FAILURES: ${failures.length} of ${checks} -> ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`  FAIL  the suite itself threw: ${String(err && (err as Error).stack || err).slice(0, 500)}`);
  process.exit(1);
});
