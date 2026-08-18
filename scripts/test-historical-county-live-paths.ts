/**
 * The production entry points, not the helper.
 *
 * `lib/historical-county-identity.ts` was correct in isolation while the live paths still
 * resolved counties by name: the scorecard reported Duval County absent because the database
 * calls that agency `Jacksonville Sheriff's Office`, and Baltimore County built a card from a
 * predicate that matched two departments and took the first. A helper nothing calls is not a
 * fix. Everything here goes through `buildHistoricalScorecard`, the route's county decision,
 * or the contract validator that enforces its result.
 *
 * The two-turn flow is exercised with the *actual* assistant scope message in history. The
 * first version of the decision function read intent from the whole conversation, and that
 * message offers "Countywide total or Sheriff's office only?" -- so every answer to it looked
 * like a countywide request and the check never ran on the one flow it exists for.
 *
 * Every assertion runs against the current database and, when HISTORICAL_REBUILD_DB_PATH is
 * set, the rebuilt one -- because the application has to be safe to deploy before the data
 * changes and after.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { buildHistoricalScorecard } from "../lib/historical-scorecard";
import { getHistoricalCountyAgencyDecision } from "../lib/historical-county-choice";
import { validateQueryContractSql } from "../lib/query-contract-validator";

let failures = 0;
let checks = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function openReadonly(file: string | undefined): Database.Database | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true });
  } catch {
    return null;
  }
}

const CURRENT_DB = process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
const REBUILT_DB = process.env.HISTORICAL_REBUILD_DB_PATH;

/** The message the existing scope clarifier actually sends. Verbatim, because that is the bug. */
const SCOPE_QUESTION =
  "For Baltimore County, do you want the countywide total (all law enforcement agencies mapped to "
  + "Baltimore County, summed — totals depend on each agency's reporting participation) or the "
  + "sheriff's office only (the single county agency record)? Choose: Countywide total or Sheriff's office only.";

function twoTurn(original: string, answer: string) {
  return [
    { role: "user", content: original },
    { role: "assistant", content: SCOPE_QUESTION },
  ] as const;
}

function exercise(db: Database.Database, side: string): void {
  console.log(`\nlive county paths against the ${side} database`);

  // ── Scorecards: Finding 2, and Finding 1 for the card path ────────────────────────
  const duval = buildHistoricalScorecard(db, "Duval County, FL scorecard");
  assert(!!duval && duval.rows.length === 9,
    `${side}: Duval County scorecard builds (rows=${duval?.rows.length ?? "none"})`);
  assert(!!duval && !/could not find/i.test(duval.explanation),
    `${side}: Duval County is not reported as absent`);
  assert(!!duval?.sql && duval.sql.includes("ha.ori = 'FL0160000'"),
    `${side}: Duval County SQL is pinned to FL0160000`);
  assert(!!duval?.sql && !duval.sql.includes("FL0160200"),
    `${side}: Duval County does not reach the Jacksonville city agency`);

  for (const [label, question] of [
    ["Baltimore County", "Baltimore County, MD scorecard"],
    ["Chatham County", "Chatham County, GA scorecard"],
  ] as const) {
    const card = buildHistoricalScorecard(db, question);
    assert(!!card && card.rows.length === 0 && /Needs Clarification/i.test(card.title),
      `${side}: ${label} clarifies instead of building a card (title=${card?.title})`);
    assert(!!card && card.sql === null, `${side}: ${label} runs no SQL while the choice is open`);
    assert(!!card && (card.explanation.match(/[A-Z]{2}\d{7}/g)?.length ?? 0) >= 2,
      `${side}: ${label} names both agencies`);
  }

  for (const [label, question, ori] of [
    ["Cook County", "Cook County, IL scorecard", "IL0160000"],
    ["Maricopa County", "Maricopa County scorecard", "AZ0070000"],
    ["St. Louis County", "St. Louis County, MO scorecard", "MO0950000"],
  ] as const) {
    const card = buildHistoricalScorecard(db, question);
    assert(!!card && card.rows.length === 9, `${side}: ${label} still builds a card`);
    assert(!!card?.sql && card.sql.includes(`ha.ori = '${ori}'`), `${side}: ${label} is pinned to ${ori}`);
  }
  const orleans = buildHistoricalScorecard(db, "Orleans Parish scorecard");
  assert(!!orleans && /more than one state/i.test(orleans.explanation),
    `${side}: Orleans Parish still asks which state`);
  const orleansLa = buildHistoricalScorecard(db, "Orleans Parish, LA scorecard");
  assert(!!orleansLa && /^Orleans Parish, LA/.test(orleansLa.agencyLabel),
    `${side}: Orleans Parish, LA resolves to the parish (label=${orleansLa?.agencyLabel})`);

  // ── The real two-turn route flow, with the assistant's own scope message present ───
  const generic = getHistoricalCountyAgencyDecision(
    db, "county agency only", twoTurn("violent crime in Baltimore County, MD", "county agency only"));
  assert(generic.kind === "clarify",
    `${side}: "county agency only" after the scope question asks which agency (got ${generic.kind})`);
  if (generic.kind === "clarify") {
    assert(generic.state === "MD", `${side}: the follow-up recovers the state`);
    assert(generic.agencies.length === 2, `${side}: both agencies are offered`);
  }

  // The same flow with the state spelled out, and no abbreviation anywhere.
  const spelled = getHistoricalCountyAgencyDecision(
    db, "county agency only", twoTurn("violent crime in Baltimore County, Maryland", "county agency only"));
  assert(spelled.kind === "clarify" && spelled.state === "MD",
    `${side}: "Maryland" spelled out is not lost during the follow-up (got ${spelled.kind})`);

  // Naming a force. On the current data both agencies carry the same name, so the answer
  // cannot be honoured and the route must decline rather than guess or fall silent.
  const sheriff = getHistoricalCountyAgencyDecision(
    db, "sheriff's office only", twoTurn("violent crime in Baltimore County, MD", "sheriff's office only"));
  if (side === "current") {
    assert(sheriff.kind === "unresolved",
      `current: "sheriff's office only" declines, because both agencies are recorded under the same name (got ${sheriff.kind})`);
    if (sheriff.kind === "unresolved") {
      assert(/cannot tell which one you mean/i.test(sheriff.explanation),
        "current: the decline says why");
    }
  } else {
    assert(sheriff.kind === "resolved" && sheriff.ori === "MD0030000",
      `rebuilt: "sheriff's office only" resolves to MD0030000 by elimination (got ${sheriff.kind})`);
  }

  // Countywide still bypasses the single-agency choice entirely.
  const countywide = getHistoricalCountyAgencyDecision(
    db, "countywide total", twoTurn("violent crime in Baltimore County, MD", "countywide total"));
  assert(countywide.kind === "countywide",
    `${side}: a countywide answer is not asked which single agency (got ${countywide.kind})`);

  // A one-agency county never reaches the question.
  const single = getHistoricalCountyAgencyDecision(
    db, "sheriff's office only", twoTurn("violent crime in Cook County, IL", "sheriff's office only"));
  assert(single.kind === "none",
    `${side}: a one-agency county continues without an extra question (got ${single.kind})`);

  // Asking twice is not an answer: once the clarification is in history, an unanswerable
  // reply declines rather than repeating the question.
  const repeated = getHistoricalCountyAgencyDecision(db, "the county one", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: SCOPE_QUESTION },
    { role: "user", content: "county agency only" },
    { role: "assistant", content: generic.kind === "clarify" ? generic.explanation : "" },
  ]);
  assert(repeated.kind === "unresolved" || repeated.kind === "resolved",
    `${side}: after asking once, an unusable answer declines rather than asking again (got ${repeated.kind})`);
}

/** The chosen ORI must be enforced against the SQL, not merely suggested to the model. */
function exerciseContract(side: string): void {
  console.log(`\ncontract enforcement of the chosen agency (${side})`);
  const question = "violent crime in Baltimore County, MD";
  const pinned = "SELECT hac.year, hac.violent FROM historical_agency_crime hac "
    + "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.ori = 'MD0030100' AND hac.year = 2020";
  const twoAgency = "SELECT hac.year, hac.violent FROM historical_agency_crime hac "
    + "JOIN historical_agency ha ON ha.ori = hac.ori "
    + "JOIN agency_county_crosswalk cw ON cw.ori9 = ha.ori "
    + "WHERE cw.county_key = 'BALTIMORE' AND LOWER(ha.type) = 'county' AND hac.year = 2020";

  const good = validateQueryContractSql({
    question, source: "historical", sql: pinned, requiredOri: "MD0030100",
  });
  assert(good.blockReasons.length === 0,
    `${side}: SQL pinned to the chosen ORI passes (blocked: ${good.blockReasons.join("; ")})`);

  const bad = validateQueryContractSql({
    question, source: "historical", sql: twoAgency, requiredOri: "MD0030100",
  });
  assert(bad.blockReasons.length > 0,
    `${side}: SQL that would match both agencies is blocked`);
  assert(bad.enforced.includes("contract-required-county-ori"),
    `${side}: the block is attributed to the required-ORI rule (${bad.enforced.join(", ")})`);

  // No requirement, no new block: this must not affect ordinary questions.
  const unrelated = validateQueryContractSql({ question, source: "historical", sql: twoAgency });
  assert(!unrelated.enforced.includes("contract-required-county-ori"),
    `${side}: the rule is inert when no agency has been chosen`);
}

const current = openReadonly(CURRENT_DB);
if (current) {
  exercise(current, "current");
  current.close();
} else {
  console.log(`\n(skipped current database: ${CURRENT_DB} not readable)`);
}

const rebuilt = openReadonly(REBUILT_DB);
if (rebuilt) {
  exercise(rebuilt, "rebuilt");
  // Only the rebuilt data spells the two departments differently, so only there can a user
  // answer by name. This is the fix working end to end.
  console.log("\nnaming an agency, which only the rebuilt data makes possible");
  const chosen = buildHistoricalScorecard(rebuilt, "Baltimore County Police Department, MD scorecard");
  assert(!!chosen && chosen.rows.length === 9,
    `rebuilt: naming the county police department builds its card (rows=${chosen?.rows.length ?? "none"})`);
  assert(!!chosen?.sql && chosen.sql.includes("ha.ori = 'MD0030100'"),
    "rebuilt: the named department's card is pinned to MD0030100");
  const settled = getHistoricalCountyAgencyDecision(
    rebuilt, "Baltimore County Police Department",
    twoTurn("violent crime in Baltimore County, MD", "Baltimore County Police Department"));
  assert(settled.kind === "resolved" && settled.ori === "MD0030100",
    `rebuilt: naming the department resolves to MD0030100 (got ${settled.kind})`);
  rebuilt.close();
} else {
  console.log("\n(skipped rebuilt database: set HISTORICAL_REBUILD_DB_PATH to exercise it)");
}

exerciseContract("shared");

console.log(`\n${checks - failures}/${checks} live county path checks passed`);
if (failures > 0) {
  console.error(`${failures} live county path check(s) failed`);
  process.exit(1);
}
console.log("historical county live path tests passed");
