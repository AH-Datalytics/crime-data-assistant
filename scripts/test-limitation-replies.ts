/**
 * What the reader is told when the product cannot answer.
 *
 * The saved failures did NOT all have one shape, and saying so was wrong. GC-026 reached the
 * generic "I could not generate a database query for that request... Please restate it with the
 * place, offense, and date range you want", whose advice can never succeed for a question whose
 * answer does not exist. GC-103/104/105 reached a hardcoded nonfatal refusal that named an outside
 * website and a different measure. Two entry-point gaps, one shared reply policy.
 *
 * These checks hold one shared composer to three things: say what is actually missing, name the
 * nearest measure the product really holds and how it differs, and keep saying nothing where
 * nothing has been established. Every reply is driven through the production functions the routes
 * call, and the wording is asserted rather than described.
 */
import assert from "node:assert/strict";
import {
  buildNoSqlFallbackMessage,
  limitationReply,
  selectNoSqlRefusal,
  asksExplicitNonfatalShootings,
  NONFATAL_SHOOTING_LIMITATION,
} from "../lib/refusal-safety";
import { readFileSync } from "fs";
import Database from "better-sqlite3";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { genericResultState } from "../lib/result-state-adapters";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); failed += 1; }
}

// The four saved requests this build is answerable for, verbatim from the completed capture.
const GC026 = "arrest rate by race for robbery in Chicago";
const GC103 = "nonfatal shootings in baltimore city by month";
const GC104 = "Nonfatal shooting rates in baltimore city from 2022 to 2025.";
const GC105 = "How many non-fatal shootings has Aurora, Colorado has in 2026?";

console.log("\nA. the saved requests now carry their own limitation");

for (const [id, question] of [["GC-103", GC103], ["GC-104", GC104], ["GC-105", GC105]] as const) {
  check(`${id}: nonfatal shootings are explained, not redirected offsite`, () => {
    const reply = limitationReply(question, "shr");
    assert.equal(reply.reason, "nonfatal-shooting-scope");
    assert.match(reply.explanation, /Nonfatal shootings are not collected here/);
    assert.match(reply.explanation, /fatal outcomes only/i);
    // The nearest measure the product actually holds, named with its source.
    assert.match(reply.explanation, /aggravated assault victims involving a firearm, on the\s+NIBRS tab/);
    // ...and the distinction, without which the alternative would be a substitution.
    assert.match(reply.explanation, /includes firearm assaults where nobody was\s+hit/);
    assert.match(reply.explanation, /not a nonfatal-shooting count/);
    // The old reply's two failings.
    assert.doesNotMatch(reply.explanation, /Gun Violence Archive|WISQARS/,
      "an outside website is not this product's nearest available measure");
    assert.doesNotMatch(reply.explanation, /I can show you fatal shootings/,
      "fatal homicides are a different measure of a different thing");
  });
}

check("GC-026: the denominator problem AND this source's scope are both stated", () => {
  const reply = limitationReply(GC026, "shr");
  assert.equal(reply.reason, "demographic-rate-denominator");
  assert.match(reply.explanation, /can't calculate a reliable per-capita rate for a demographic group/);
  assert.match(reply.explanation, /does not include matching population denominators/);
  // Saying only "no denominators" would leave the reader thinking SHR holds robbery arrests.
  assert.match(reply.explanation, /covers homicide only/);
  assert.match(reply.explanation, /does not\s+hold arrests or non-homicide offenses at all/);
  // The alternative is labelled as another source's, and promises no coverage.
  assert.match(reply.explanation, /would be a NIBRS question, subject to what the agency reported/);
  assert.doesNotMatch(reply.explanation, /Chicago/,
    "no promise about the requested place's coverage");
});

check("a limitation delivers no figure, no title and no query", () => {
  for (const question of [GC026, GC103]) {
    const reply = limitationReply(question, "shr");
    assert.equal(reply.sql, null);
    assert.equal(reply.title, "");
    assert.deepEqual(reply.rows, []);
    assert.equal(reply.rowCount, 0);
    assert.equal(reply.chartConfig, null);
    assert.doesNotMatch(reply.explanation, /\b\d{2,}\b/, "a limitation is not a figure");
  }
});

console.log("\nB. the wording is a policy, not four remembered sentences");

check("a differently phrased nonfatal request gets the same limitation", () => {
  for (const question of [
    "how many people were shot and survived in Oakland last year",
    "non fatal shooting incidents in Denver by month",
    "shooting survivors in Detroit 2024",
    "people shot who survived in Philadelphia 2024",
    "survivors of shootings in Oakland 2024",
    "how many people survived a shooting in Detroit last year",
  ]) {
    const reply = limitationReply(question, "shr");
    assert.equal(reply.reason, "nonfatal-shooting-scope", question);
    assert.match(reply.explanation, /aggravated assault victims involving a firearm/, question);
  }
});

check("an independent demographic-rate request gets the denominator limitation", () => {
  const reply = limitationReply("homicide rate for black residents in Detroit 2023", "shr");
  assert.equal(reply.reason, "demographic-rate-denominator");
  assert.match(reply.explanation, /population denominators/);
});

console.log("\nC. what must not change");

check("a request with no established limitation keeps the generic template, word for word", () => {
  for (const source of ["shr", "nibrs", "current", "historical"]) {
    const question = "how many wombats were reported in 2024";
    const reply = selectNoSqlRefusal(question, source);
    assert.equal(reply.reason, "no-sql-server-template", source);
    assert.equal(reply.explanation, buildNoSqlFallbackMessage(source), source);
  }
});

check("court-process wording and its precedence are unchanged", () => {
  const question = "Please show me a graph of the violent crime rate back to 1930 and also the U.S. prison population";
  const reply = selectNoSqlRefusal(question, "historical");
  assert.equal(reply.reason, "court-data-out-of-scope");
  assert.match(reply.explanation, /not court outcomes or policy data/);
});

check("a court request that also mentions a demographic rate stays a court refusal", () => {
  // Precedence, asserted rather than assumed: the first policy still wins.
  const reply = selectNoSqlRefusal(
    "conviction rate by race for robbery in Chicago", "nibrs");
  assert.equal(reply.reason, "court-data-out-of-scope");
});

check("a fatal-only question is not diverted into the nonfatal explanation", () => {
  for (const question of [
    "fatal shootings in Chicago since 2015",
    "firearm homicides in Baltimore by year",
  ]) {
    assert.equal(asksExplicitNonfatalShootings(question), false, question);
    assert.notEqual(selectNoSqlRefusal(question, "shr").reason, "nonfatal-shooting-scope", question);
  }
});

check("a request whose nonfatal meaning is not established keeps the generic reply", () => {
  /*
   * THE ERROR THIS REPLACES. I copied the SHR route's routing regex into the shared selector and
   * called it "explicit nonfatal". It was not: `shooting incidents`, `people shot` and
   * `gunshot victim` all matched, so an explicitly FATAL request selected the nonfatal explanation
   * -- and because the selector is shared, that reading reached the Current, Historical and NIBRS
   * no-SQL callers, which never had it.
   *
   * None of these establishes that anyone survived. A victim can be a fatal victim; an incident can
   * be a fatal incident. The last one was a POSITIVE in my first submission and is kept here as a
   * negative rather than deleted, because it is the case that showed the predicate was wrong.
   */
  const unestablished = [
    // THE RESIDUAL. Injury is evidence of harm, never of survival, and this request says outright
    // that the outcome was fatal. It reached the delivered payload, not just a helper tag.
    "How many people were shot and fatally injured in Chicago in 2024?",
    // Injury wording alone, with no outcome stated either way.
    "people shot and wounded in Philadelphia 2024",
    "gunshot injuries in Baltimore 2024",
    // Survival wording whose sense is the opposite, and wording that says both things at once.
    "how many people shot did not survive in Chicago 2024",
    "none of the victims shot survived in Chicago 2024",
    "no one survived the shootings in Chicago last year",
    "fatal and nonfatal shootings in Chicago 2024",
    // A survival word that is not about the shooting being asked for.
    "how many shootings in Chicago in 2024 in neighborhoods where flood victims survived",
    // Codex's two residuals from the proximity version: the first describes a FLOOD survivor and
    // passed a distance test; the second negates the word "nonfatal" itself, the same grant in
    // the other polarity.
    "How many shootings near flood survivors in Chicago?",
    // A linked phrase that is NEGATED: the phrase is present and the request excludes it.
    "not counting nonfatal shootings, how many were there in Chicago?",
    "no one survived a shooting in Detroit last year",
    // "nonfatal" about something that is not a shooting at all.
    "nonfatal assaults in Chicago 2024",
    "Show shootings that were not nonfatal in Chicago.",
    "fatal shooting incidents in Chicago since 2015",
    "shooting incidents in Chicago since 2015",
    "how many people shot in Chicago in 2024",
    "how many gunshot victim reports did Philadelphia have in 2024",
    "shootings in Chicago since 2015",
  ];
  for (const question of unestablished) {
    assert.equal(asksExplicitNonfatalShootings(question), false, question);
    // On EVERY caller of the shared selector, not one SHR example: this is where the reading spread.
    for (const source of ["shr", "nibrs", "current", "historical"]) {
      const reply = selectNoSqlRefusal(question, source);
      assert.notEqual(reply.reason, "nonfatal-shooting-scope", `${source}: ${question}`);
      assert.doesNotMatch(reply.explanation, /Nonfatal shootings are not collected/,
        `${source}: ${question}`);
    }
  }
  // GC-110's bare question is among them. It remains a separate open issue; nothing here repairs it.
});

check("a table-selection warning is not promoted into a claim that data is unavailable", () => {
  /*
   * `validateSourceCapabilities` also returns WARNINGS -- "use this table instead" -- which say
   * nothing about availability. Accepting every finding would have turned a routing hint into a
   * refusal. Only two rule ids, both at `unsupported` severity, may become a limitation.
   */
  const source = readFileSync("lib/refusal-safety.ts", "utf8");
  assert.match(source, /REFUSABLE_CAPABILITY_RULES = new Set\(\[/);
  assert.match(source, /finding\.severity === "unsupported" && REFUSABLE_CAPABILITY_RULES\.has/);
  const allowlist = source.slice(source.indexOf("REFUSABLE_CAPABILITY_RULES"));
  assert.equal((allowlist.slice(0, allowlist.indexOf("]")).match(/"/g) ?? []).length, 4,
    "exactly two rule ids may become a refusal");

  // Behaviourally: a request whose only finding is a table-selection warning keeps the template.
  const reply = selectNoSqlRefusal("robbery victims by weapon in Houston 2023", "nibrs");
  assert.equal(reply.reason, "no-sql-server-template");
});

check("GC-029's earlier clarification is untouched by this build", () => {
  // It never reaches this composer: `shouldAskCrimeType` answers first. Recorded so the scope of
  // this milestone cannot be misread as covering it.
  const routeSource = readFileSync("app/api/nibrs-query/route.ts", "utf8");
  assert.match(routeSource, /shouldAskCrimeType/);
});

console.log("\nD. both SHR exits deliver the same limitation");

check("the explicit nonfatal branch and the model no-SQL exit agree", () => {
  const source = readFileSync("app/api/shr-query/route.ts", "utf8");
  // The nonfatal branch builds its whole answer from the shared reply...
  //
  // It reads `shootingRequest` rather than `question` since the Decision 14 repair: on the turn
  // that answers "nonfatal", the bare word is the ANSWER to the fatal/nonfatal question and
  // `shootingRequest` is the original request with that word in it. Reading `question` there
  // would hand this composer a bare "nonfatal" with no place and no years. On every other turn
  // the two are the same string.
  assert.match(source, /const reply = limitationReply\(shootingRequest, "shr"\);/);
  assert.match(source, /const shootingRequest = shootingScopeFollowup\?\.reconstructedQuestion \?\? question;/);
  assert.match(source, /explanation: reply\.explanation/);
  assert.match(source, /title: reply\.title, columns: reply\.columns, rows: reply\.rows, rowCount: reply\.rowCount/);
  // ...and the model no-SQL exit now consults the same selector instead of the bare template.
  assert.match(source, /const noSqlRefusal = selectNoSqlRefusal\(question, "shr"\);/);
  assert.match(source, /routeGuardrailsFired\.push\(noSqlRefusal\.reason\)/);
  // The guards around that exit are preserved.
  assert.match(source, /!serverAuthoredNoSql && !containsInternalLeak\(claude\.explanation\) && !containsInternalLeak\(claude\.title\)/);
  // Behaviourally, both exits produce the same wording for the same request.
  assert.equal(limitationReply(GC103, "shr").explanation, NONFATAL_SHOOTING_LIMITATION);
  assert.equal(selectNoSqlRefusal(GC103, "shr").explanation, NONFATAL_SHOOTING_LIMITATION);
});

check("a supported answer still delivers its figure, and never reaches this composer", () => {
  /*
   * The preservation check the approval names. This build only ever runs where NO statement was
   * produced, so an answer that did produce one must be untouched -- both in the route's structure
   * and in what the reader receives.
   */
  const source = readFileSync("app/api/shr-query/route.ts", "utf8");
  const noSqlAt = source.indexOf('const noSqlRefusal = selectNoSqlRefusal(question, "shr");');
  assert.ok(noSqlAt > 0, "the SHR no-SQL exit must call the selector");
  assert.match(source.slice(Math.max(0, noSqlAt - 1200), noSqlAt), /if \(!claude\.sql\)/,
    "the selector is reached only when no statement was produced");

  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (year INT, murders INT); INSERT INTO t VALUES (2023, 41), (2024, 37);");
  const sql = "SELECT year, murders FROM t ORDER BY year";
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  db.close();
  assert.equal(rows.length, 2);

  const delivered = applyResultDisclosures({
    explanation: "Baltimore reported 41 murders in 2023 and 37 in 2024.",
    question: "murders in Baltimore 2023 to 2024", sql, rows, tab: "shr",
    resultState: genericResultState({ sql, rows, queryCompleted: true }),
  });
  assert.match(delivered, /\b41\b/, "a supported figure still reaches the reader");
  assert.match(delivered, /\b37\b/);
  assert.doesNotMatch(delivered, /could not generate a database query/,
    "an answered request never picks up a limitation reply");
});

check("hate crime's caller is deliberately left alone", () => {
  const source = readFileSync("app/api/hc-query/route.ts", "utf8");
  assert.match(source, /buildNoSqlFallbackMessage\("hate_crime"\)/,
    "out of this bounded slice; unrelated rewiring is not part of it");
});

check("the availability neutraliser still guards an unverified claim", () => {
  const { neutralizeUnverifiedAvailabilityClaim } = require("../lib/refusal-safety");
  const neutralised = neutralizeUnverifiedAvailabilityClaim(
    "Iowa City is not in our dataset.", "homicide");
  assert.match(neutralised, /couldn't verify/i);
});

console.log(`\nlimitation replies: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
