/**
 * The production entry points, not the helper.
 *
 * `lib/historical-county-identity.ts` was correct in isolation while the live paths still
 * resolved counties by name: the scorecard reported Duval County absent because the database
 * calls that agency `Jacksonville Sheriff's Office`, and Baltimore County built a card from a
 * predicate that matched two departments and took the first. A helper nothing calls is not a
 * fix. Everything here goes through `buildHistoricalScorecard` or the route's clarifier.
 *
 * Every assertion runs against the current database and, when HISTORICAL_REBUILD_DB_PATH is
 * set, the rebuilt one -- because the application has to be safe to deploy before the data
 * changes and after.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { buildHistoricalScorecard } from "../lib/historical-scorecard";
import { getHistoricalCountyAgencyChoice } from "../lib/historical-county-choice";

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

function exercise(db: Database.Database, side: string): void {
  console.log(`\nlive county paths against the ${side} database`);

  // ── Finding 2: Duval resolves, and is not reported absent ──────────────────────────
  const duval = buildHistoricalScorecard(db, "Duval County, FL scorecard");
  assert(!!duval && duval.rows.length === 9,
    `${side}: Duval County scorecard builds (rows=${duval?.rows.length ?? "none"})`);
  assert(!!duval && !/could not find/i.test(duval.explanation),
    `${side}: Duval County is not reported as absent`);
  assert(!!duval?.sql && duval.sql.includes("ha.ori = 'FL0160000'"),
    `${side}: Duval County SQL is pinned to FL0160000`);
  // And it is the county agency, not the city of Jacksonville.
  assert(!!duval?.sql && !duval.sql.includes("FL0160200"),
    `${side}: Duval County does not reach the Jacksonville city agency`);

  // ── Finding 1: two-agency counties clarify rather than select ──────────────────────
  for (const [label, question] of [
    ["Baltimore County", "Baltimore County, MD scorecard"],
    ["Chatham County", "Chatham County, GA scorecard"],
  ] as const) {
    const card = buildHistoricalScorecard(db, question);
    assert(!!card && card.rows.length === 0 && /Needs Clarification/i.test(card.title),
      `${side}: ${label} clarifies instead of building a card (title=${card?.title})`);
    assert(!!card && card.sql === null,
      `${side}: ${label} runs no SQL while the choice is open`);
    assert(!!card && /which one do you want/i.test(card.explanation),
      `${side}: ${label} asks which agency`);
    // Both agencies must be named, or the user cannot answer.
    assert(!!card && (card.explanation.match(/ORI |\([A-Z]{2}\d{7}\)/g)?.length ?? 0) >= 2
      || !!card && (card.explanation.match(/[A-Z]{2}\d{7}/g)?.length ?? 0) >= 2,
      `${side}: ${label} names both agencies`);
  }

  // ── Accepted behaviour is retained ─────────────────────────────────────────────────
  for (const [label, question, ori] of [
    ["Cook County", "Cook County, IL scorecard", "IL0160000"],
    ["Maricopa County", "Maricopa County scorecard", "AZ0070000"],
    ["St. Louis County", "St. Louis County, MO scorecard", "MO0950000"],
  ] as const) {
    const card = buildHistoricalScorecard(db, question);
    assert(!!card && card.rows.length === 9, `${side}: ${label} still builds a card`);
    assert(!!card?.sql && card.sql.includes(`ha.ori = '${ori}'`),
      `${side}: ${label} is pinned to ${ori}`);
  }
  // A Louisiana parish still asks for its state, because Orleans is also a county in NY and VT.
  const orleans = buildHistoricalScorecard(db, "Orleans Parish scorecard");
  assert(!!orleans && /more than one state/i.test(orleans.explanation),
    `${side}: Orleans Parish still asks which state`);
  // Orleans Parish has no year with every scorecard row populated, so it declines rather
  // than building a card. What matters here is that naming the state resolves the parish
  // instead of asking again, and that the decline is about missing years, not a missing agency.
  const orleansLa = buildHistoricalScorecard(db, "Orleans Parish, LA scorecard");
  assert(!!orleansLa && /^Orleans Parish, LA/.test(orleansLa.agencyLabel),
    `${side}: Orleans Parish, LA resolves to the parish (label=${orleansLa?.agencyLabel})`);
  assert(!!orleansLa && !/more than one state|which one do you want|could not find/i.test(orleansLa.explanation),
    `${side}: Orleans Parish, LA is neither re-asked nor reported absent`);

  // ── The follow-up: naming an agency settles it, and is not asked twice ─────────────
  // "the county agency" says the scope but not which force, so both databases must ask.
  const asked = getHistoricalCountyAgencyChoice(db, "just the county agency", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
  ]);
  assert(!!asked && asked.agencies.length === 2,
    `${side}: a single-agency follow-up for Baltimore County asks which agency`);
  assert(!!asked && asked.state === "MD", `${side}: the follow-up knows the state`);

  // Asked once: with the clarification already in the history it must not re-ask.
  const reAsked = getHistoricalCountyAgencyChoice(db, "just the county agency", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: asked?.explanation ?? "" },
  ]);
  assert(reAsked === null, `${side}: the agency clarifier does not ask twice`);

  // "sheriff's office only" is an answer on the rebuilt data and not on the current data,
  // and that difference is the defect rather than a quirk of the code: today both of
  // Baltimore County's agencies carry the same rewritten name, so nothing can tell the
  // sheriff's office from the county police department and the user cannot answer either.
  const sheriffOnly = getHistoricalCountyAgencyChoice(db, "sheriff's office only", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
  ]);
  if (side === "rebuilt") {
    assert(sheriffOnly === null,
      "rebuilt: naming the sheriff settles it, because the other agency is named a police department");
  } else {
    assert(!!sheriffOnly,
      "current: naming the sheriff cannot settle it, because both agencies carry the same name");
  }

  // Countywide requests are a different path and must not be intercepted.
  const countywide = getHistoricalCountyAgencyChoice(db, "countywide total", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
  ]);
  assert(countywide === null, `${side}: a countywide request is not asked which single agency`);

  // A county with one agency never reaches the clarifier at all.
  const single = getHistoricalCountyAgencyChoice(db, "sheriff's office only", [
    { role: "user", content: "violent crime in Cook County, IL" },
  ]);
  assert(single === null, `${side}: a one-agency county is not asked to choose`);
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
  const settled = getHistoricalCountyAgencyChoice(rebuilt, "Baltimore County Police Department", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
  ]);
  assert(settled === null, "rebuilt: naming the department settles the question");
  rebuilt.close();
} else {
  console.log("\n(skipped rebuilt database: set HISTORICAL_REBUILD_DB_PATH to exercise it)");
}

console.log(`\n${checks - failures}/${checks} live county path checks passed`);
if (failures > 0) {
  console.error(`${failures} live county path check(s) failed`);
  process.exit(1);
}
console.log("historical county live path tests passed");
