#!/usr/bin/env npx tsx

import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { resolveNibrsPlaces } from "../lib/nibrs-place-resolver.js";
import { planNibrsQuery } from "../lib/nibrs-query-planner.js";
import { AGENCY_PERIOD_RANKING_GUARDRAIL, agencyPeriodRankingNote, agencyPeriodRankingSql, EARLIER_TABLE_STATEMENT, recognizeAgencyPeriodRanking, resolveRankingExplanationFollowup } from "../lib/nibrs-agency-period-ranking.js";

const db = new Database(":memory:");
db.exec("CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT); CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT); INSERT INTO agencies VALUES ('ILCHI0000', 2024, 'IL', 'CHICAGO', 'City', 2600000, '1A', 'N', 'E'), ('CA0193500', 2016, 'CA', 'LAKEWOOD', 'City', 81921, '3', 'N', 'C'); INSERT INTO agency_county_crosswalk VALUES ('CA01935', 'CA0193500', 'Lakewood', 'CA', 'LOS ANGELES');");

const mixedQuestion = "Compare murder rates in Chicago, IL and Lakewood, CA from 2021 to 2024";
const mixedPlan = resolveNibrsPlaces(db, mixedQuestion);
assert.ok(mixedPlan);
const blocked = planNibrsQuery(mixedQuestion, mixedPlan);
assert.equal(blocked.kind, "blocked");
if (blocked.kind === "blocked") assert.match(blocked.explanation, /in this comparison/);

const resolvedQuestion = "Murder trend in Chicago, IL from 2024 to 2024";
const resolvedPlan = resolveNibrsPlaces(db, resolvedQuestion);
assert.ok(resolvedPlan);
assert.equal(planNibrsQuery(resolvedQuestion, resolvedPlan).kind, "deterministic");
assert.equal(planNibrsQuery(resolvedQuestion, resolvedPlan, { allowDeterministic: false }).kind, "model");

const juvenileIncident = planNibrsQuery(
  "how many violent crime incidents in 2025 had one or more offenders under age 18",
  null
);
assert.equal(juvenileIncident.kind, "unavailable");
if (juvenileIncident.kind === "unavailable") {
  assert.match(juvenileIncident.explanation, /count offenders rather than distinct incidents/i);
  assert.match(juvenileIncident.explanation, /without risking double-counting/i);
}
const availableJuvenileIncident = planNibrsQuery(
  "how many violent crime incidents nationwide in 2025 had any offenders under age 18",
  null,
  { allowDeterministic: true, juvenileIncidentRollupAvailable: true }
);
assert.equal(availableJuvenileIncident.kind, "deterministic");
if (availableJuvenileIncident.kind === "deterministic") {
  assert.match(availableJuvenileIncident.query.sql, /summary_juvenile_offender_incidents/);
  assert.match(availableJuvenileIncident.query.sql, /offense_scope = 'violent_crime'/);
  assert.match(availableJuvenileIncident.query.sql, /s\.year = 2025/);
  assert.match(availableJuvenileIncident.query.explanation, /counted once/i);
  assert.match(availableJuvenileIncident.query.explanation, /not a national estimate/i);
  db.exec("CREATE TABLE summary_juvenile_offender_incidents(year INT,month INT,state TEXT,ori TEXT,offense_scope TEXT,incident_count INT); INSERT INTO summary_juvenile_offender_incidents VALUES (2025,0,'IL','ORI1','violent_crime',5),(2025,1,'IL','ORI1','violent_crime',3),(2025,2,'TX','ORI2','violent_crime',4),(2025,1,'IL','ORI1','120',2);");
  const row = db.prepare(availableJuvenileIncident.query.sql).get() as { juvenile_offender_incidents: number };
  assert.equal(row.juvenile_offender_incidents, 12);
  const monthly = planNibrsQuery(
    "violent crime incidents by month in 2025 with any offenders under age 18",
    null,
    { allowDeterministic: true, juvenileIncidentRollupAvailable: true }
  );
  assert.equal(monthly.kind, "deterministic");
  if (monthly.kind === "deterministic") {
    assert.match(monthly.query.sql, /s\.month BETWEEN 1 AND 12/);
    const rows = db.prepare(monthly.query.sql).all() as { month: number; juvenile_offender_incidents: number }[];
    assert.deepEqual(rows, [
      { year: 2025, month: 1, juvenile_offender_incidents: 3 },
      { year: 2025, month: 2, juvenile_offender_incidents: 4 },
    ]);
  }
}
// ---------------------------------------------------------------------------------------------------------------------
// GC-091 batch (lib/nibrs-agency-period-ranking.ts; correction r1, Codex :37374): "top N police agencies by murders" over a
// period, one row per agency, the requested cohort kept, honest labels; and the explanation follow-up about it.
// ---------------------------------------------------------------------------------------------------------------------
{
  const DEC_2025 = { year: 2025, month: 12, observed: true };
  const GC091 = "Murders for top 10 police agencies from 2010 to present";

  // Recognition: positive whole-turn forms only; the cohort is read from the agency words (r1, F1).
  assert.deepEqual(recognizeAgencyPeriodRanking(GC091), { kind: "request", count: 10, startYear: 2010, end: { kind: "present" }, cohort: "all" });
  assert.deepEqual(recognizeAgencyPeriodRanking("Top 5 police departments by murders since 2015."), { kind: "request", count: 5, startYear: 2015, end: { kind: "present" }, cohort: "all" });
  assert.deepEqual(recognizeAgencyPeriodRanking("murders for the top 3 law enforcement agencies 2015-2020"), { kind: "request", count: 3, startYear: 2015, end: { kind: "year", year: 2020 }, cohort: "all" });
  assert.deepEqual(recognizeAgencyPeriodRanking("Murders for top 10 municipal police agencies between 2012 and 2014"), { kind: "request", count: 10, startYear: 2012, end: { kind: "year", year: 2014 }, cohort: "city" });
  assert.deepEqual(recognizeAgencyPeriodRanking("Top 10 city police departments by murders since 2012"), { kind: "request", count: 10, startYear: 2012, end: { kind: "present" }, cohort: "city" });
  // Not this family: an added constraint, a rate, another offense, a city noun (the single-year city ranking's family), no period.
  for (const q of [
    "Murders for top 10 police agencies from 2010 to present in Texas",
    "Murder rate for top 10 police agencies from 2010 to present",
    "Murders per capita for top 10 police agencies from 2010 to present",
    "Robberies for top 10 police agencies from 2010 to present",
    "Murders for top 10 cities from 2010 to present",
    "Top 10 cities by murders in 2024",
    "Murders for top 10 police agencies",
    "Murders for top 10 police agencies with at least 100,000 people from 2010 to present",
    "Murders for top 10 county police agencies from 2010 to present",
  ]) assert.equal(recognizeAgencyPeriodRanking(q), null, q);
  // Recognized but not carryable: owned, never model.
  assert.equal(recognizeAgencyPeriodRanking("Murders for top 0 police agencies since 2015")?.kind, "unsupported");
  assert.equal(recognizeAgencyPeriodRanking("Murders for top 51 police agencies since 2015")?.kind, "unsupported");
  assert.equal(recognizeAgencyPeriodRanking("Murders for top 10 police agencies from 1985 to present")?.kind, "unsupported");
  assert.equal(recognizeAgencyPeriodRanking("Murders for top 10 police agencies 2020-2015")?.kind, "unsupported");

  // Planning: deterministic with the family's guardrail; never model as a follow-up; period from observed evidence only.
  const plan = planNibrsQuery(GC091, null, { allowDeterministic: true, dataCutoff: DEC_2025 });
  assert.equal(plan.kind, "deterministic");
  if (plan.kind === "deterministic") {
    assert.equal(plan.query.guardrail, AGENCY_PERIOD_RANKING_GUARDRAIL);
    assert.equal(plan.query.title, "Top 10 police agencies by murder victims, 2010–2025");
    assert.match(plan.query.sql, /WHERE s\.ucr_offense_code = '09A' AND s\.year BETWEEN 2010 AND 2025 GROUP BY s\.ori\)/);
    assert.doesNotMatch(plan.query.sql.split("), places AS")[0], /agency_type/, "the broad cohort's totals have no type filter");
    assert.match(plan.query.sql, /ORDER BY t\.murders DESC, t\.ori ASC LIMIT 10$/);
    assert.doesNotMatch(plan.query.sql, /population|rate_per/i);
    assert.match(plan.query.explanation, /every agency NIBRS records murder victims for, of any type/);
    assert.equal(plan.query.xAxis, "agency_label");
  }
  const municipal = planNibrsQuery("Murders for top 10 municipal police agencies from 2010 to present", null, { allowDeterministic: true, dataCutoff: DEC_2025 });
  assert.equal(municipal.kind, "deterministic");
  if (municipal.kind === "deterministic") {
    assert.equal(municipal.query.title, "Top 10 municipal police agencies by murder victims, 2010–2025");
    assert.match(municipal.query.sql, /AND a\.agency_type = 'City' GROUP BY s\.ori\)/);
    assert.match(municipal.query.explanation, /city \(municipal\) agencies, as asked/);
  }
  assert.equal(planNibrsQuery(GC091, null, { allowDeterministic: false, dataCutoff: DEC_2025 }).kind, "unavailable");
  assert.equal(planNibrsQuery(GC091, null, { allowDeterministic: true, dataCutoff: { year: 2025, month: 12, observed: false } }).kind, "unavailable");
  assert.equal(planNibrsQuery(GC091, null, { allowDeterministic: true, dataCutoff: null }).kind, "unavailable");
  assert.equal(planNibrsQuery("Murders for top 10 police agencies 2010-2030", null, { allowDeterministic: true, dataCutoff: DEC_2025 }).kind, "unavailable");
  // A source that stops part-way through its latest year: the statement covers exactly what the title claims.
  const partial = planNibrsQuery(GC091, null, { allowDeterministic: true, dataCutoff: { year: 2026, month: 6, observed: true } });
  assert.equal(partial.kind, "deterministic");
  if (partial.kind === "deterministic") {
    assert.equal(partial.query.title, "Top 10 police agencies by murder victims, 2010–June 2026");
    assert.match(partial.query.sql, /s\.year BETWEEN 2010 AND 2026 AND \(s\.year < 2026 OR s\.month <= 6\)/);
  }

  // The statement on a small fixture: one row per agency over the period, every type for the broad cohort, honest labels.
  const f = new Database(":memory:");
  f.exec("CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, PRIMARY KEY (ori, year)); CREATE TABLE summary_victim_city_monthly (ori TEXT, state TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER); CREATE TABLE agency_county_crosswalk (ori TEXT PRIMARY KEY, ori9 TEXT, agency_name TEXT, state TEXT);");
  const ag = f.prepare("INSERT INTO agencies VALUES (?, ?, ?, ?, ?, ?)");
  const sv = f.prepare("INSERT INTO summary_victim_city_monthly VALUES (?, ?, ?, ?, '09A', ?)");
  const cw = f.prepare("INSERT INTO agency_county_crosswalk VALUES (?, ?, ?, 'IL')");
  for (const y of [2020, 2021, 2022]) {
    ag.run("AAA", y, "IL", y < 2022 ? "OLDNAME" : "NEWNAME", "City", 1000 + y);
    ag.run("BBB", y, "IL", "BBB CITY", "City", 500 + y);
    ag.run("CTY", y, "IL", "A COUNTY", "County", 9000);
    ag.run("ZZZ", y, "IL", "ZERO TOWN", "City", 50);
    sv.run("AAA", "IL", y, 1, 5); sv.run("AAA", "IL", y, 2, 5);   // 30 over three years
    sv.run("CTY", "IL", y, 1, 100);                               // county: 300, kept for the broad cohort
    sv.run("ZZZ", "IL", y, 1, 0);                                 // genuine zero
  }
  sv.run("BBB", "IL", 2021, 1, 15); sv.run("BBB", "IL", 2022, 1, 15); // 30: ties AAA, ordered by ORI
  sv.run("NOREC", "IL", 2021, 1, 4);                                    // victims, but no agencies record
  ag.run("NOPLACE", 2021, "IL", null, "Other", 0); sv.run("NOPLACE", "IL", 2021, 1, 2); // a record with no place
  sv.run("AAA", "IL", 2019, 1, 99);                                     // outside the period
  cw.run("AAA1", "AAA", "AAA POLICE DEPARTMENT");                       // one crosswalk name
  cw.run("CTY1", "CTY", "A COUNTY SHERIFF");                            // two DIFFERENT names: not used
  cw.run("CTY2", "CTY", "A COUNTY POLICE");
  const P2022 = { startYear: 2020, endYear: 2022, throughMonth: null };
  const all = f.prepare(agencyPeriodRankingSql(10, P2022, "all")).all() as Record<string, unknown>[];
  assert.deepEqual(all.map((r) => [r.ori, r.agency_name, r.agency_type, r.agency_label, r.murders, r.years_with_records]), [
    ["CTY", null, "County", "A COUNTY, IL, County agency (CTY)", 300, 3],
    ["AAA", "AAA POLICE DEPARTMENT", "City", "AAA POLICE DEPARTMENT, IL (AAA)", 30, 3],
    ["BBB", null, "City", "BBB CITY, IL, City agency (BBB)", 30, 2],
    ["NOREC", null, null, "ORI NOREC (no NIBRS agency record)", 4, 1],
    ["NOPLACE", null, "Other", "ORI NOPLACE (no place recorded)", 2, 1],
    ["ZZZ", null, "City", "ZERO TOWN, IL, City agency (ZZZ)", 0, 3],
  ]);
  const city = f.prepare(agencyPeriodRankingSql(10, P2022, "city")).all() as Record<string, unknown>[];
  assert.deepEqual(city.map((r) => [r.ori, r.city, r.murders]), [["AAA", "NEWNAME", 30], ["BBB", "BBB CITY", 30], ["ZZZ", "ZERO TOWN", 0]]);
  assert.equal(f.prepare(agencyPeriodRankingSql(1, P2022, "all")).all().length, 1);
  f.close();

  // Row-derived statements.
  const q = { guardrail: AGENCY_PERIOD_RANKING_GUARDRAIL, sql: "" };
  const row = (ori: string, name: string | null, city: string, type: string, murders: number, years: number) => ({ ori, agency_name: name, city, state: "IL", agency_type: type, murders, years_with_records: years });
  const base = { requestedCount: 3, startYear: 2020, endYear: 2022, cohort: "all" as const };
  const tie = agencyPeriodRankingNote(q, [row("A", "Aville Police", "Aville", "City", 30, 3), row("B", null, "Bville", "County", 30, 2), row("C", null, "Cville", "City", 10, 3)], { ...base, explanation: true });
  assert.ok(tie && tie.lead && tie.tail);
  assert.ok(tie!.lead!.startsWith(EARLIER_TABLE_STATEMENT), "the one statement about the earlier display leads");
  assert.ok(EARLIER_TABLE_STATEMENT.startsWith("The earlier table isn't kept in this conversation, so I can't confirm what it showed"));
  assert.ok(tie!.lead!.includes("In the ranking run now, the totals are not all the same: they range from 30 (Aville Police, IL) to 10 (Cville, IL (City agency))."));
  assert.ok(tie!.lead!.includes("Aville Police, IL and Bville, IL (County agency) each have 30: these are different agencies whose totals are equal, not repeated rows."));
  assert.doesNotMatch(tie!.lead!, /different numbers|did not show a ranking table|was this same ranking|no figures in it/, "nothing is inferred about the earlier display");
  assert.ok(tie!.tail!.includes("By NIBRS agency type, the agencies shown are 2 City and 1 County."));
  assert.ok(tie!.tail!.includes("2 of the 3 agencies shown have murder victim records in every year 2020–2022; the other 1 covers fewer years"));
  const allEqual = agencyPeriodRankingNote(q, [row("A", null, "Aville", "City", 7, 3), row("B", null, "Bville", "City", 7, 3)], { ...base, explanation: true });
  assert.ok(allEqual!.lead!.includes("In the ranking run now, all 2 agencies have the same total, 7; they are 2 different agencies (different ORIs), not one agency repeated."));
  const sameLabel = agencyPeriodRankingNote(q, [row("A", null, "Kansas City", "City", 9, 3), row("B", null, "Kansas City", "City", 8, 3)], { ...base, explanation: true });
  assert.ok(sameLabel!.lead!.includes("[A]") && sameLabel!.lead!.includes("[B]"), "an identical label is told apart by ORI");
  const noPlace = agencyPeriodRankingNote(q, [{ ori: "NP", agency_name: null, city: null, state: "IL", agency_type: "Other", murders: 3, years_with_records: 3 }, row("B", null, "Bville", "City", 1, 3)], { ...base, explanation: true });
  assert.ok(noPlace!.lead!.includes("from 3 (ORI NP) to 1 (Bville, IL (City agency))"), "a row without a place is named by its ORI");
  const fewer = agencyPeriodRankingNote(q, [row("A", null, "Aville", "City", 3, 3)], { ...base, requestedCount: 10, cohort: "city", explanation: false });
  assert.equal(fewer!.lead, null);
  assert.ok(fewer!.tail!.startsWith("Only 1 agency has murder victim records in this period, so it is shown."));
  assert.doesNotMatch(fewer!.tail!, /By NIBRS agency type/, "the municipal cohort is one type");
  assert.deepEqual(agencyPeriodRankingNote(q, [], { ...base, startYear: 1995, endYear: 1996, explanation: false }),
    { lead: null, tail: "No agency has murder victim records in the NIBRS source for 1995–1996." });
  assert.equal(agencyPeriodRankingNote(q, [], { ...base, startYear: 1995, endYear: 1996, cohort: "city", explanation: false })!.tail, "No city police agency has murder victim records in the NIBRS source for 1995–1996.");
  assert.throws(() => agencyPeriodRankingNote(q, [row("A", null, "Aville", "City", 3, 3), row("A", null, "Aville", "City", 3, 3)], { ...base, explanation: false }), /more than once/);
  assert.equal(agencyPeriodRankingNote({ guardrail: "another-family", sql: "" }, [], { ...base, explanation: false }), null);

  // The explanation follow-up: only right after a request of this family. Nothing is read from the preceding answer (r2):
  // every preceding answer -- the saved model answer, a rates limitation followed by a counts table (Codex's counterexample),
  // a failure, this family's own answer, a quoted caption, or none -- resolves identically.
  const preceding = [
    "This data contains murder counts and rates per 100,000 population for the top 10 police agencies by city, including Chicago, Philadelphia, and Houston.",
    "I can't calculate comparable rates over this period. The table shows murder counts for each agency, including Chicago, Philadelphia, and Houston.",
    "I couldn't complete this request. That's a failure on our side, not a statement about the data.",
    "Top 10 police agencies by murder victims, 2010–2025. Each agency appears once, with its murder victims summed …",
    "The caption read \"Top 10 police agencies by murder victims, 2010–2025. Each agency appears once\" but Chicago appeared four times.",
  ];
  for (const answer of [...preceding, null]) {
    const history = answer === null ? [{ role: "user", content: GC091 }] : [{ role: "user", content: GC091 }, { role: "assistant", content: answer }];
    assert.deepEqual(resolveRankingExplanationFollowup("Why are murders the same for all of these cities?", history), { priorQuestion: GC091, refinedQuestion: GC091 }, String(answer));
  }
  const saved = [{ role: "user", content: GC091 }, { role: "assistant", content: preceding[0] }];
  assert.ok(resolveRankingExplanationFollowup("why do these agencies appear more than once", saved));
  for (const [question, history] of [
    ["Why are murders the same for all of these cities in Texas?", saved],
    ["Show the same for robberies", saved],
    ["Why are murders the same for all of these cities?", [{ role: "user", content: "Compare the rape clearance rate for the Denver Police Department against 3 agencies of similar size." }]],
    ["Why are murders the same for all of these cities?", [{ role: "user", content: "Murder rate for top 10 police agencies from 2010 to present" }]],
    ["Why are murders the same for all of these cities?", []],
    ["Why are murders the same for all of these cities?", null],
  ] as [string, unknown][]) assert.equal(resolveRankingExplanationFollowup(question, history), null, question);
}
db.close();
console.log("nibrs query planner tests passed");
