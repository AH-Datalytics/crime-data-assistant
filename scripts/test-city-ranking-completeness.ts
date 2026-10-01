/**
 * S1 reaches the Current and NIBRS city rankings (Codex combined review): the shared decision in
 * lib/city-ranking-completeness.ts, fed by each source's own evidence, on the committed DDL in memory.
 *
 *   1. the decision itself: identity before eligibility, request-relevant splits, the three conditions;
 *   2. Current: scope-only candidates, a City/unrecorded month split excluded and named, an unrecorded
 *      agency that could place makes the ranking partial, a complete ranking keeps its statement;
 *   3. NIBRS: unresolved-only candidates under the key-enforced identity, partial when one could place,
 *      a second record for one agency-year refused as a broken premise;
 *   4. every candidates statement passes the route's structural proof.
 *
 * Expected values are written from the rows inserted here.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { recognizeCityRanking, type CityRankingRequest } from "../lib/city-ranking";
import { buildCityRanking, type BuiltCityRanking } from "../lib/city-ranking-builder";
import { completenessOf, decideCandidates, type CompletenessPlan } from "../lib/city-ranking-completeness";
import { CURRENT_CITY_AUTHORITY } from "../lib/entity-authority";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}
const CUTOFF = { year: 2024, month: 12, observed: true };
const build = (q: string, source: "current" | "nibrs"): BuiltCityRanking & { completeness: CompletenessPlan } => {
  const r = recognizeCityRanking(q, source);
  if (!r || r.kind !== "ranking") throw new Error(`not recognized: ${q}`);
  const b = buildCityRanking(r as CityRankingRequest, CUTOFF);
  if (!b || !b.completeness) throw new Error(`no completeness plan: ${q}`);
  return b as BuiltCityRanking & { completeness: CompletenessPlan };
};
/** The route's flow, in order: candidates, then the ranked statement without disagreeing agencies. */
function run(db: Database.Database, b: BuiltCityRanking & { completeness: CompletenessPlan }) {
  const decision = decideCandidates(b.completeness, db.prepare(b.completeness.candidatesSql).all() as Record<string, unknown>[]);
  if (decision.kind !== "decided") return { decision, sql: null, rows: [], result: null };
  const sql = decision.conflicted.length ? b.completeness.ranked(decision.conflicted) : b.sql;
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  return { decision, sql, rows, result: completenessOf(b.completeness, decision, rows, b.title) };
}

console.log("\n1 - the shared decision");
{
  const plan: CompletenessPlan = {
    source: "current", authority: CURRENT_CITY_AUTHORITY, typeSource: "the Current source", candidateScope: "scope-only",
    candidatesSql: "", ranked: () => "", amountColumn: "offenses", verifiable: false, quantity: "rate_per_100k",
    populationConditions: [{ comparison: ">", value: 100000 }], countConditions: [{ comparison: ">=", value: 10 }], limit: 2, direction: "desc",
  };
  const rows = [
    { ori: "A", city: "Alpha", state: "ZZ", recorded_type: "City", population: 200000, offenses: 100 },       // 50
    { ori: "B", city: "Beta", state: "ZZ", recorded_type: "", population: 300000, offenses: 120 },            // 40, unresolved
    { ori: "C", city: "Gamma", state: "ZZ", recorded_type: "County", population: 400000, offenses: 300 },     // ineligible
    { ori: "D", city: "Delta", state: "ZZ", recorded_type: "City", population: 90000, offenses: 90 },         // below the limit
    { ori: "E", city: "Eps", state: "ZZ", recorded_type: "City", population: 500000, offenses: 5 },           // below the count
    { ori: "S", city: "Sigma", state: "ZZ", recorded_type: "City", population: 200000, offenses: 60 },        // split, relevant
    { ori: "S", city: "Sigma", state: "ZZ", recorded_type: "", population: 200000, offenses: 40 },
    { ori: "T", city: "Tau", state: "ZZ", recorded_type: "County", population: 200000, offenses: 60 },        // split, never a city
    { ori: "T", city: "Tau", state: "ZZ", recorded_type: "Other", population: 200000, offenses: 40 },
    { ori: "U", city: "Upsilon", state: "ZZ", recorded_type: "City", population: 50000, offenses: 60 },       // split, below the limit both times
    { ori: "U", city: "Upsilon PD", state: "ZZ", recorded_type: "City", population: 50000, offenses: 40 },
  ];
  const d = decideCandidates(plan, rows);
  check(d.kind === "decided" && d.conflicted.join() === "S,T,U", "every disagreeing agency is found before any condition applies");
  check(d.kind === "decided" && d.relevantSplits.map((x) => x.ori).join() === "S",
    "only a split that could enter the result is relevant: County/Other pieces and pieces below the limit are not");
  check(d.kind === "decided" && d.confirmed.map((c) => c.ori).join() === "A" && d.unresolved.map((c) => c.ori).join() === "B",
    "eligibility is applied in code: type, population limit and count condition");
  if (d.kind === "decided") {
    const result = completenessOf(plan, d, [{ city: "Alpha", state: "ZZ", offenses: 100, population: 200000 }], "Cities by X");
    check(!result.complete && /Beta, ZZ \(40, would rank 2nd\)/.test(result.sentences.join(" ")) && /Sigma, ZZ \(S\) has conflicting records in the Current source/.test(result.sentences.join(" ")),
      "partial: the unresolved agency and the relevant split are named");
    check(!/Tau|Upsilon/.test(result.sentences.join(" ")), "irrelevant splits are not named");
  }
}

console.log("\n2 - Current city rankings");
function currentDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("scripts/fixtures/operation-taxonomy/crime_data.ddl.sql", "utf8"));
  const add = (ori: string, agency: string, type: string, months: number[], count: number, population: number | null) => {
    for (const m of months) db.prepare("INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)")
      .run(ori, agency, "ZZ", type, 2024, m, "Murder", count);
    if (population !== null) db.prepare("INSERT OR IGNORE INTO agency_population (ori, year, population) VALUES (?,?,?)").run(ori, 2024, population);
  };
  return { db, add };
}
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const CQ = "Which 2 cities had the most murders in 2024?";
{
  const { db, add } = currentDb();
  add("CA1", "Alpha", "City", ALL, 10, 200000);     // 120
  add("CB1", "Beta", "City", ALL, 5, 300000);       // 60
  add("CC1", "Gamma", "County", ALL, 20, 400000);   // not a city
  const b = build(CQ, "current");
  const whereClause = (b.completeness.candidatesSql.split(" WHERE ")[1] ?? "").split(" GROUP BY ")[0];
  check(whereClause.length > 0 && !/type|City|population|HAVING/.test(whereClause) &&/GROUP BY am\.ori, am\.agency, am\.state, am\.type/.test(b.completeness.candidatesSql),
    "Current candidates read the scope only, grouped by name, state and recorded type");
  check(b.completeness.ranked([]) === b.sql, "with nothing excluded the ranked statement is the long-standing one");
  const out = run(db, b);
  check(out.result?.complete === true && JSON.stringify(out.rows.map((r) => [r.city, r.offenses])) === JSON.stringify([["Alpha", 120], ["Beta", 60]]) && out.sql === b.sql,
    "complete: the same statement, the same rows, no partial wording");
  // An unrecorded agency with more murders than the second city.
  add("CD1", "Delta", "", ALL, 8, 250000);          // 96
  const partial = run(db, b);
  check(partial.result?.complete === false && /Delta, ZZ \(96, would rank 2nd\)/.test(partial.result.sentences.join(" "))
    && /^Partial ranking: .*\(confirmed cities only\)$/.test(partial.result.title), "an unrecorded agency that could place makes it partial and is named");
  // Alpha recorded as City for six months and as nothing for six: its ranked total would lose six months.
  const { db: db2, add: add2 } = currentDb();
  add2("CA1", "Alpha", "City", [1, 2, 3, 4, 5, 6], 10, 200000);
  add2("CA1", "Alpha", "", [7, 8, 9, 10, 11, 12], 10, 200000);
  add2("CB1", "Beta", "City", ALL, 5, 300000);
  add2("CE1", "Eta", "City", ALL, 1, 300000);
  const split = run(db2, b);
  check(split.decision.kind === "decided" && split.decision.conflicted.join() === "CA1" && /am\.ori NOT IN \('CA1'\)/.test(String(split.sql))
    && !split.rows.some((r) => r.city === "Alpha") && /Alpha, ZZ \(CA1\) has conflicting records in the Current source/.test(split.result?.sentences.join(" ") ?? ""),
    "a City/unrecorded month split is found, excluded from the ranked statement and named, not ranked on half its months");
  check(deterministicPlanRefusal({ question: CQ, source: "current", sql: b.completeness.candidatesSql }) === null
    && deterministicPlanRefusal({ question: CQ, source: "current", sql: b.completeness.ranked(["CA1"]) }) === null,
    "the Current candidates and exclusion statements pass the route's structural proof");
  const rate = build("Which 2 cities over 100k population had the highest murder rates in 2024?", "current");
  check(/LEFT JOIN agency_population ap/.test(rate.completeness.candidatesSql) && !/ap\.population [<>]/.test(rate.completeness.candidatesSql)
    && deterministicPlanRefusal({ question: "Which 2 cities over 100k population had the highest murder rates in 2024?", source: "current", sql: rate.completeness.candidatesSql }) === null,
    "a Current rate ranking's candidates carry population without filtering on it, and pass the structural proof");
  db.close(); db2.close();
}

console.log("\n3 - NIBRS city rankings");
function nibrsDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("scripts/fixtures/operation-taxonomy/nibrs.ddl.sql", "utf8"));
  const add = (ori: string, city: string, type: string | null, count: number, population: number) => {
    db.prepare("INSERT INTO agencies (ori, year, state, city, population, agency_type) VALUES (?,?,?,?,?,?)").run(ori, 2024, "ZZ", city, population, type);
    for (const m of ALL) db.prepare("INSERT INTO summary_city_monthly (ori, state, year, month, ucr_offense_code, offense_count) VALUES (?,?,?,?,?,?)").run(ori, "ZZ", 2024, m, "09A", count);
  };
  return { db, add };
}
const NQ = "Which 2 cities had the most murders in 2024?";
{
  const { db, add } = nibrsDb();
  add("NA1", "ALPHA", "City", 10, 200000);   // 120
  add("NB1", "BETA", "City", 5, 300000);     // 60
  add("NC1", "GAMMA", "County", 20, 400000);
  const b = build(NQ, "nibrs");
  check(b.completeness.candidateScope === "unresolved-only" && /\(a\.agency_type IS NULL OR a\.agency_type = ''\)/.test(b.completeness.candidatesSql)
    && !/a\.agency_type = 'City'/.test(b.completeness.candidatesSql), "NIBRS candidates: the unresolved agencies under the same eligibility");
  const out = run(db, b);
  check(out.result?.complete === true && out.sql === b.sql, "complete: the ranked statement is unchanged");
  add("ND1", "DELTA", null, 8, 250000);      // 96, no recorded type
  const partial = run(db, b);
  check(partial.result?.complete === false && /DELTA, ZZ \(96, would rank 2nd\)|Delta, ZZ \(96, would rank 2nd\)/.test(partial.result.sentences.join(" "))
    && /recorded in NIBRS/.test(partial.result.sentences.join(" ")), "an agency NIBRS records no type for, that could place, makes it partial");
  check(decideCandidates(b.completeness, [
    { ori: "X", city: "X", state: "ZZ", recorded_type: null, population: 1, offenses: 1 },
    { ori: "X", city: "X2", state: "ZZ", recorded_type: null, population: 1, offenses: 1 },
  ]).kind === "inconsistent", "two records for one NIBRS agency-year break the key premise and are refused, not ranked");
  check(decideCandidates(b.completeness, [{ ori: "X", city: "X", state: "ZZ", recorded_type: "City", population: 1, offenses: 1 }]).kind === "inconsistent",
    "an unresolved-only read that returns a recorded type is refused");
  let excludeRefused = false;
  try { b.completeness.ranked(["X"]); } catch { excludeRefused = true; }
  check(excludeRefused, "the NIBRS ranked statement cannot be asked to exclude an agency");
  check(deterministicPlanRefusal({ question: NQ, source: "nibrs", sql: b.completeness.candidatesSql }) === null,
    "the NIBRS candidates statement passes the route's structural proof");
  db.close();
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
