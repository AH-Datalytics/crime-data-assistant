import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { validateAndSanitize } from "../lib/sql-safety.js";
import { resolveNibrsPlaces } from "../lib/nibrs-place-resolver.js";
import {
  buildNibrsClearanceMethodQuery,
  buildNibrsClearanceTypeBreakdownQuery,
  buildNibrsComparableAgencyClearanceQuery,
  buildNibrsDomesticViolenceAggravatedAssaultShareQuery,
  buildNibrsLocalCityOffenseCountQuery,
  buildNibrsLocalDemographicQuery,
  buildNibrsStructuredLocalTrendQuery,
  nibrsWithheldRateNote,
  withoutNibrsMetadata,
} from "../lib/nibrs-deterministic-queries.js";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard.js";
import { resolvePeerCountFollowup } from "../lib/peer-count-followup.js";
import { comparableAgencySubjectCheck, subjectRowCountFrom } from "../lib/nibrs-deterministic-queries.js";
import { planNibrsQuery } from "../lib/nibrs-query-planner.js";
import { buildQueryContract } from "../lib/query-contract.js";
import { alignTitleYearRange, applyResultDisclosures } from "../lib/result-disclosure.js";
import { genericResultState } from "../lib/result-state-adapters.js";
import { validateGrain } from "../lib/requested-grain.js";
import { normalizeConsolidatedDisplayRows } from "../lib/agency-consolidations.js";

{
  const query = buildNibrsComparableAgencyClearanceQuery(
    "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size from 2021 to 2024",
    {
      question: "",
      startYear: 2021,
      endYear: 2024,
      hasStateComparison: false,
      elapsedMs: 0,
      places: [{
        contractIndex: 0,
        requestedName: "San Francisco",
        label: "San Francisco Police Department",
        state: "CA",
        kind: "city_police",
        status: "resolved",
        confidence: "high",
        oriYears: [
          { year: 2021, ori: "CA0380100", population: 815201 },
          { year: 2022, ori: "CA0380100", population: 808437 },
          { year: 2023, ori: "CA0380100", population: 808988 },
          { year: 2024, ori: "CA0380100", population: 827526 },
        ],
        oriRanges: [{ ori: "CA0380100", startYear: 2021, endYear: 2024 }],
          reason: "test",
      }],
    },
    // Increment 5: peers are now selected by the shared population core, not by a SQL
    // LIMIT over an ordered pool, so the builder takes an injectable candidate source.
    // Decision 16 requires every peer named and the real band stated, which is only
    // possible when the chosen set is a value the code holds.
    () => [
      { ori: "WA0170100", agency: "Seattle", state: "WA", population: 750000 },
      { ori: "CO0160100", agency: "Denver", state: "CO", population: 715000 },
      { ori: "TN0190100", agency: "Nashville", state: "TN", population: 690000 },
      { ori: "MD0300100", agency: "Baltimore", state: "MD", population: 585000 },
    ]
  );
  assert.ok(query, "similar-size agency clearance comparison should be deterministic");
  // The three nearest by population are selected in code and read by the query.
  assert.match(query.sql, /'WA0170100'/);
  assert.match(query.sql, /'CO0160100'/);
  assert.match(query.sql, /'TN0190100'/);
  assert.doesNotMatch(query.sql, /'MD0300100'/, "the fourth-nearest agency must not be selected");
  assert.doesNotMatch(query.sql, /candidate_pool/, "peer selection must no longer happen in SQL");
  // Decision 16: the rule, the band and every peer are named in the explanation.
  assert.match(query.explanation, /population alone/i);
  assert.match(query.explanation, /Seattle/);
  assert.match(query.explanation, /Denver/);
  assert.match(query.explanation, /Nashville/);
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/);
  assert.match(query.sql, /ucr_offense_code IN \('11A', '11B', '11C'\)/);
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2024/);
  assert.match(query.sql, /arrest_rate_pct/);
  assert.match(query.sql, /exceptional_rate_pct/);
  assert.equal(validateAndSanitize(query.sql).valid, true);
  assert.equal(query.guardrail, "deterministic-nibrs-comparable-agency-clearance");
}

{
  // AGENCY+RANK batch (GC-115/116). The plan above was REFUSED by the structural proof in production: a CTE column
  // list and `AS MATERIALIZED` left `place_label` untraceable, so the request fell through to model SQL that chose
  // "peers" by clearance rate. The saved questions now resolve, pass the proof and return the subject plus exactly
  // the requested population peers, each once per year.
  const peerDb = new Database(":memory:");
  peerDb.exec(`
    CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
    CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
    CREATE TABLE summary_clearance_type (ori TEXT, year INTEGER, ucr_offense_code TEXT, total_offenses INTEGER, cleared_by_arrest INTEGER, cleared_exceptional INTEGER);
    CREATE INDEX idx_sct_ori_year ON summary_clearance_type(ori, year);
  `);
  const peers: [string, string, string, number][] = [
    ["CA0380100", "SAN FRANCISCO", "CA", 808000], ["WA0170100", "SEATTLE", "WA", 750000], ["CO0160100", "DENVER", "CO", 715000],
    ["TN0190100", "NASHVILLE", "TN", 690000], ["MD0300100", "BALTIMORE", "MD", 585000], ["TX2270100", "AUSTIN", "TX", 975000],
    ["OH0250100", "COLUMBUS", "OH", 905000], ["NC0600100", "CHARLOTTE", "NC", 880000], ["IN0490100", "INDIANAPOLIS", "IN", 885000],
    ["TX0570100", "FORT WORTH", "TX", 950000], ["OK0550100", "OKLAHOMA CITY", "OK", 690500],
  ];
  const insAgency = peerDb.prepare("INSERT INTO agencies VALUES (?, ?, ?, ?, 'City', ?, '1B', 'N', 'E')");
  const insSct = peerDb.prepare("INSERT INTO summary_clearance_type VALUES (?, ?, '11A', 100, 30, 5)");
  for (const [ori, city, st, pop] of peers) for (let y = 2021; y <= 2025; y++) { insAgency.run(ori, y, st, city, pop); insSct.run(ori, y); }
  const source = (q: { year: number; excludeOri: string; population: number }) =>
    (peerDb.prepare("SELECT ori, city AS agency, state, population FROM agencies WHERE year = ? AND ori <> ? ORDER BY ABS(population - ?), ori LIMIT 100")
      .all(q.year, q.excludeOri, q.population) as { ori: string; agency: string; state: string; population: number }[]);

  const gc115 = "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size.";
  const plan115 = resolveNibrsPlaces(peerDb, gc115);
  assert.equal(plan115?.places[0]?.kind, "city_police", "the named department resolves to its city police agency");
  assert.equal(plan115?.places[0]?.status, "resolved");
  const q115 = buildNibrsComparableAgencyClearanceQuery(gc115, plan115, source);
  assert.ok(q115, "GC-115 is built by the owned plan");
  assert.doesNotMatch(q115.sql, /MATERIALIZED/i);
  assert.equal(deterministicPlanRefusal({ question: gc115, source: "nibrs", sql: q115.sql }), null, "GC-115's owned plan passes the structural proof");
  const rows115 = peerDb.prepare(q115.sql).all() as Record<string, unknown>[];
  assert.equal(new Set(rows115.map((r) => r.ori)).size, 4, "GC-115 returns the subject and exactly 3 peers");
  assert.equal(new Set(rows115.map((r) => `${r.ori}|${r.year}`)).size, rows115.length, "one row per agency per year, never one per population value");
  assert.match(q115.explanation, /selected on population alone/);
  assert.match(q115.explanation, /populations from [\d,]+ to [\d,]+/, "the population band is stated");
  assert.match(q115.explanation, /Seattle, WA/i);
  assert.match(q115.explanation, /closest in size to San Francisco Police Department, CA \(808,000\)/, "the subject is named with its state");

  const gc116Prior = gc115;
  const gc116 = "Add San Francisco PD to the table and increase to 8 comparable agencies.";
  const followup = resolvePeerCountFollowup(gc116, [{ role: "user", content: gc116Prior }, { role: "assistant", content: "..." }], "nibrs");
  assert.ok(followup, "GC-116 carries the prior peer request forward");
  assert.equal(followup.peerCount, 8);
  assert.equal(followup.refinedQuestion, "Compare the rape clearance rate for the San Francisco Police Department against 8 agencies of similar size.");
  const q116 = buildNibrsComparableAgencyClearanceQuery(followup.refinedQuestion, resolveNibrsPlaces(peerDb, followup.refinedQuestion), source);
  assert.ok(q116);
  assert.equal(deterministicPlanRefusal({ question: followup.refinedQuestion, source: "nibrs", sql: q116.sql }), null);
  const rows116 = peerDb.prepare(q116.sql).all() as Record<string, unknown>[];
  assert.equal(new Set(rows116.map((r) => r.ori)).size, 9, "GC-116 returns the subject and exactly 8 peers");

  // Controls: the follow-up is narrow.
  assert.equal(resolvePeerCountFollowup(gc116, [{ role: "user", content: "Rape clearance rate for San Francisco 2021 to 2024" }], "nibrs"), null,
    "no carry-forward when the prior request was not a peer comparison");
  assert.equal(resolvePeerCountFollowup("Increase to 8 comparable agencies and show robbery instead.", [{ role: "user", content: gc116Prior }], "nibrs"), null,
    "a turn that changes the offense is not a count-only follow-up");
  assert.equal(resolvePeerCountFollowup("Add Oakland PD and increase to 8 comparable agencies.", [{ role: "user", content: gc116Prior }], "nibrs"), null,
    "a different named agency is not the prior subject");
  assert.equal(resolvePeerCountFollowup(gc116, [{ role: "user", content: gc116Prior }], "historical"), null, "NIBRS only");
  assert.equal(resolvePeerCountFollowup("Increase to 8 comparable agencies for 2019 to 2020.", [{ role: "user", content: gc116Prior }], "nibrs"), null,
    "a turn naming its own period is not a count-only follow-up");
  // Correction F1 (Codex :36392): positively count-only. Codex's counterexamples keep their added meaning (left as written).
  const prior = [{ role: "user", content: gc116Prior }];
  for (const turn of [
    "Increase to 8 comparable agencies, but use only agencies that reported all 12 months.",
    "Increase to 8 comparable agencies, but exclude the original agency from the table.",
    "Add San Francisco, TX to the table and increase to 8 comparable agencies.",
    "Increase to 8 comparable agencies, but show counts instead of clearance rates.",
    "Increase to 8 comparable agencies in California.",
    "Increase to 8 comparable agencies with more than 500,000 residents.",
    "Add San Francisco, Texas to the table and increase to 8 comparable agencies.",
    "Add San Francisco Sheriff to the table and increase to 8 comparable agencies.",
  ]) assert.equal(resolvePeerCountFollowup(turn, prior, "nibrs"), null, turn);
  // ...while the genuine count-only forms, including the same subject with its own state, are carried forward.
  for (const [turn, n] of [
    ["Increase to 8 comparable agencies.", 8], ["increase it to 6 comparable agencies", 6], ["Use 5 comparable agencies instead.", 5],
    ["Add San Francisco Police Department back to the table and increase to 8 comparable agencies.", 8],
    ["Add San Francisco, CA to the table and increase to 8 comparable agencies.", 8],
    ["Increase to 7 comparable agencies and add San Francisco PD too.", 7],
  ] as [string, number][]) {
    const f = resolvePeerCountFollowup(turn, prior, "nibrs");
    assert.equal(f?.peerCount, n, turn);
    assert.equal(f?.refinedQuestion, gc116Prior.replace("against 3 agencies", `against ${n} agencies`), turn);
  }

  // Subject-data check before peer selection (release-g P1; Codex :37036). Same resolved subject, period and codes as the
  // peer builder; the check reads the clearance summary (real in-memory table here) or an injected count.
  const plan115b = resolveNibrsPlaces(peerDb, gc115);
  const realCount = subjectRowCountFrom(peerDb);   // the production statement, on the fixture database
  assert.deepEqual(comparableAgencySubjectCheck(gc115, plan115b, realCount), { kind: "present" }, "subject rows present -> plan proceeds");
  peerDb.prepare("DELETE FROM summary_clearance_type WHERE ori = 'CA0380100'").run();
  const absent = comparableAgencySubjectCheck(gc115, plan115b, realCount);
  assert.equal(absent?.kind, "absent", "no subject rows (read succeeded) -> confirmed absence");
  assert.equal(absent && "explanation" in absent ? absent.explanation : "",
    "No rape clearance records were found for San Francisco Police Department in the available NIBRS source for 2021–2025; a comparison with agencies of similar size cannot be calculated. Peers are not shown because a comparison without the requested agency would be misleading.");
  // Genuine zero: a row whose total is 0 is data, not absence.
  peerDb.prepare("INSERT INTO summary_clearance_type VALUES ('CA0380100', 2023, '11A', 0, 0, 0)").run();
  assert.deepEqual(comparableAgencySubjectCheck(gc115, plan115b, realCount), { kind: "present" }, "a zero-total row is a genuine zero, not absence");
  // Unreadable: a failed read is never reported as absence or zero.
  const unreadable = comparableAgencySubjectCheck(gc115, plan115b, () => { throw new Error("SQLITE_BUSY (test)"); });
  assert.equal(unreadable?.kind, "unreadable");
  assert.match(unreadable && "explanation" in unreadable ? unreadable.explanation : "", /^I couldn't check whether San Francisco Police Department has rape clearance records for 2021–2025.*not a finding that the records are missing or zero\.$/);
  // The injected count receives exactly the subject's ORIs, period and offense codes.
  let seen: unknown = null;
  comparableAgencySubjectCheck(gc115, plan115b, (q) => { seen = q; return 1; });
  assert.deepEqual(seen, { pairs: [2021, 2022, 2023, 2024, 2025].map((year) => ({ ori: "CA0380100", year })), codes: ["11A", "11B", "11C"] },
    "the count is asked for exactly the eligible subject-year pairs");

  // Correction r1 (Codex :37200, F1): availability on the comparison's EXACT eligible pairs. Codex's reproduction:
  // period 2021-2022, the subject resolved with a positive population only in 2022, and records only in 2021.
  const f1Db = new Database(":memory:");
  f1Db.exec(`CREATE TABLE summary_clearance_type (ori TEXT, year INTEGER, ucr_offense_code TEXT, total_offenses INTEGER, cleared_by_arrest INTEGER, cleared_exceptional INTEGER);
    CREATE INDEX idx_sct_ori_year ON summary_clearance_type(ori, year);
    INSERT INTO summary_clearance_type VALUES ('CA0380100', 2021, '11A', 40, 10, 2);`);
  const f1Count = subjectRowCountFrom(f1Db);
  const f1Q = "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size from 2021 to 2022";
  const f1Plan = (pop2021: number | null) => ({
    question: "", startYear: 2021, endYear: 2022, hasStateComparison: false, elapsedMs: 0,
    places: [{ contractIndex: 0, requestedName: "San Francisco", label: "San Francisco Police Department", state: "CA", kind: "city_police" as const,
      status: "resolved" as const, confidence: "high" as const, reason: "test",
      oriYears: [{ year: 2021, ori: "CA0380100", population: pop2021 as number }, { year: 2022, ori: "CA0380100", population: 808000 }],
      oriRanges: [{ ori: "CA0380100", startYear: 2021, endYear: 2022 }] }],
  });
  for (const pop2021 of [0, null]) {
    const r = comparableAgencySubjectCheck(f1Q, f1Plan(pop2021) as never, f1Count);
    assert.equal(r?.kind, "ineligible", `records only in a year without a usable population (${pop2021}) are not 'present'`);
    assert.equal(r && "explanation" in r ? r.explanation : "",
      "San Francisco Police Department has rape clearance records in the available NIBRS source only for 2021, and that year has no population figure for the agency, which the comparison with agencies of similar size needs. The year that does have one (2022) has no rape clearance records, so no comparison is shown and peers are not selected.");
    const planned = planNibrsQuery(f1Q, f1Plan(pop2021) as never, { allowDeterministic: true, subjectRowCount: f1Count });
    assert.equal(planned.kind, "unavailable", "declined before the peer builder runs");
  }
  // ...the same records on an eligible year are 'present'; none anywhere is 'absent'; a failing broader read is 'unreadable'.
  f1Db.exec("INSERT INTO summary_clearance_type VALUES ('CA0380100', 2022, '11B', 0, 0, 0)");
  assert.deepEqual(comparableAgencySubjectCheck(f1Q, f1Plan(null) as never, f1Count), { kind: "present" }, "an eligible-year row (even a zero total) is present");
  f1Db.exec("DELETE FROM summary_clearance_type");
  assert.equal(comparableAgencySubjectCheck(f1Q, f1Plan(null) as never, f1Count)?.kind, "absent");
  let calls = 0;
  const failSecond: typeof f1Count = (q) => { calls += 1; if (calls > 1) throw new Error("timeout (test)"); return 0; };
  assert.equal(comparableAgencySubjectCheck(f1Q, f1Plan(null) as never, failSecond)?.kind, "unreadable", "a failure on the broader read is not reported as absence");
  // No eligible pair at all (no positive population in the period): not this check's call; the existing decline applies.
  assert.equal(comparableAgencySubjectCheck(f1Q, { ...f1Plan(null), places: [{ ...f1Plan(null).places[0], oriYears: [{ year: 2021, ori: "CA0380100", population: null }, { year: 2022, ori: "CA0380100", population: 0 }] }] } as never, f1Count), null);
  // Not this family / not a single resolved subject: no check (other routes unchanged).
  assert.equal(comparableAgencySubjectCheck("Rape clearance rate for San Francisco from 2021 to 2024", plan115b, realCount), null);
  assert.equal(comparableAgencySubjectCheck(gc115, null, realCount), null);
  // The planner declines with the specific reason BEFORE the peer builder; present data still reaches the builder.
  const declined = planNibrsQuery(gc115, plan115b, { allowDeterministic: true, subjectRowCount: () => 0 });
  assert.equal(declined.kind, "unavailable");
  assert.match(declined.kind === "unavailable" ? declined.explanation : "", /^No rape clearance records were found for San Francisco Police Department/);
  const failed = planNibrsQuery(gc115, plan115b, { allowDeterministic: true, subjectRowCount: () => { throw new Error("timeout (test)"); } });
  assert.match(failed.kind === "unavailable" ? failed.explanation : "", /^I couldn't check whether/);
  // The count-only follow-up carries the same subject, so it gets the same specific decline.
  const f116 = resolvePeerCountFollowup(gc116, [{ role: "user", content: gc116Prior }], "nibrs")!;
  const declined116 = planNibrsQuery(f116.refinedQuestion, resolveNibrsPlaces(peerDb, f116.refinedQuestion), { allowDeterministic: true, subjectRowCount: () => 0 });
  assert.match(declined116.kind === "unavailable" ? declined116.explanation : "", /^No rape clearance records were found for San Francisco Police Department/);
}

{
  // A city clearance-method query must filter by the RESOLVED agency, never by
  // agencies.city. That column is a mailing city: 'SAINT LOUIS' matches 53
  // agencies in production, so the old city-name predicate summed the entire
  // metro into one figure -- the 8376 defect, in the deterministic path, where
  // the model-path ORI enforcement cannot see it.
  const cityDb = new Database(":memory:");
  cityDb.exec(`
    CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
    CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
    INSERT INTO agencies VALUES
      ('ILCPD0000', 2021, 'IL', 'CHICAGO', 'City', 2700000, '1A', 'N', 'E'),
      ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E'),
      ('MOSPD0000', 2025, 'MO', 'SAINT LOUIS', 'City', 274819, '1C', 'N', 'E'),
      ('MO0957300', 2025, 'MO', 'SAINT LOUIS', 'City', 34147, '4', 'N', 'E'),
      ('MO0956200', 2025, 'MO', 'ST LOUIS', 'City', 9052, '6', 'N', 'E');
  `);

  const chicagoQ = "How many robberies in Chicago were cleared by arrest versus exceptional means from 2021 to 2025?";
  const query = buildNibrsClearanceMethodQuery(chicagoQ, resolveNibrsPlaces(cityDb, chicagoQ));
  assert.ok(query, "city clearance-method comparison should be deterministic");
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i);
  assert.match(query.sql, /sct\.ucr_offense_code = '120'/i);
  assert.match(query.sql, /sct\.ori IN \('ILCPD0000'\)/i);
  assert.doesNotMatch(query.sql, /city\s*=/i, "must not select the agency by city name");
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2025/i);
  assert.equal(query.guardrail, "deterministic-nibrs-clearance-method");

  // St. Louis resolves to SLMPD alone, not every agency sharing the mailing city
  for (const stl of [
    "murder clearance by arrest and exceptional means in St Louis, MO in 2025",
    "murder clearances by arrest and exceptional means in St Louis, MO in 2025",
  ]) {
    const built = buildNibrsClearanceMethodQuery(stl, resolveNibrsPlaces(cityDb, stl));
    assert.ok(built, `plural and singular must both reach the deterministic path: ${stl}`);
    assert.match(built.sql, /sct\.ori IN \('MOSPD0000'\)/i);
    assert.doesNotMatch(built.sql, /city\s*=/i);
  }

  // With nothing resolved there is no safe query to build; fall through to the
  // model, where resolvedOriEnforcementIssue applies.
  assert.equal(buildNibrsClearanceMethodQuery(chicagoQ, null), null);

  // This builder emits one geography predicate, so a multi-place request must not
  // reach it. Left unguarded it answered for the first city and dropped the rest
  // silently -- an answer that looks complete and is not.
  cityDb.exec("INSERT INTO agencies VALUES ('TXDPD0000', 2025, 'TX', 'DALLAS', 'City', 1246336, '1A', 'N', 'E');");
  const twoCityQ = "murder clearances by arrest and exceptional means in Chicago and Dallas in 2025";
  const twoCityPlan = resolveNibrsPlaces(cityDb, twoCityQ);
  assert.equal(
    twoCityPlan?.places.filter((p) => p.status === "resolved").length,
    2,
    "fixture must resolve both cities, so the guard is what declines and not a resolution failure"
  );
  assert.equal(
    buildNibrsClearanceMethodQuery(twoCityQ, twoCityPlan),
    null,
    "multi-city clearance requests must go to the model path, not answer for city one"
  );
  cityDb.close();
}

{
  const query = buildNibrsClearanceMethodQuery(
    "How many robberies in Texas were cleared by arrest versus exceptional means from 2021 to 2025?"
  );
  assert.ok(query, "state clearance-method comparison should be deterministic");
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_state_year/i);
  assert.match(query.sql, /sct\.state = 'TX'/i);
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2025/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence?"
  );
  assert.ok(query, "national DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bFROM summary_victim_circumstance\b/i);
  assert.match(query.sql, /\bFROM summary_victim_state_monthly\b/i);
  assert.match(query.sql, /\bucr_offense_code = '13A'/i);
  assert.match(query.sql, /\bcircumstance_code = '06'/i);
  assert.doesNotMatch(query.sql, /\bsummary_domestic_violence\b/i);
  assert.doesNotMatch(query.sql, /\bJOIN\s+summary_victim_circumstance\b/i);
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /default last five complete calendar years/i);
  assert.equal(query.chartHint, "line");
  assert.equal(query.xAxis, "year");
  assert.equal(query.yAxis, "domestic_violence_share_pct");
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults over the past 5 years are domestic violence incidents?"
  );
  assert.ok(query, "relative-year DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults in Nebraska are domestic violence?"
  );
  assert.ok(query, "Nebraska state DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bstate IN \('NE', 'NB'\)/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence over all available years?"
  );
  assert.ok(query, "explicit all-years DV aggravated-assault share should be deterministic");
  assert.doesNotMatch(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /over all available years/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "domestic violence aggravated assault counts by race"
  );
  assert.equal(query, null, "non-share DV aggravated-assault questions should stay with normal routing");
}


{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglaries from 2000 to 2026"
  );
  assert.ok(query, "local Omaha burglary trend should be deterministic");
  assert.match(query.sql, /summary_city_monthly AS s INDEXED BY idx_scm_ori_year/i);
  assert.match(query.sql, /\bucr_offense_code = '220'/i);
  assert.match(query.sql, /\bstate IN \('NE','NB'\)/i);
  assert.match(query.sql, /\bcity = 'OMAHA'/i);
  assert.match(query.sql, /\byear BETWEEN 2000 AND 2026\b/i);
  assert.doesNotMatch(query.sql, /\bsummary_state_monthly\b/i);
  assert.equal(query.guardrail, "deterministic-nibrs-local-city-offense-count");
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglaries per month from 2023 to 2026"
  );
  assert.ok(query, "monthly local Omaha burglary trend should be deterministic");
  assert.match(query.sql, /SELECT s\.year, s\.month,/i);
  assert.match(query.sql, /GROUP BY s\.year, s\.month/i);
  assert.equal(query.title, "Omaha, NE Burglaries Per Month, 2023 to 2026", "round 1 Q7: place, measure, grain and years");
}
{
  // Round 1 Q7 (owner report): a topic with no short alias is named by its resolved offense, never "NIBRS offenses in ...".
  const query = buildNibrsLocalCityOffenseCountQuery("Omaha NE vehicle burglaries per month from 2023 to 2026");
  assert.ok(query, "local vehicle burglary trend should be deterministic");
  assert.match(query.sql, /\bucr_offense_code = '23F'/i);
  assert.equal(query.title, "Omaha, NE Thefts From Vehicles Per Month, 2023 to 2026");
  assert.ok(!/NIBRS offenses/i.test(query.title) && !/\boffenses\b/i.test(query.title), "never the generic 'offenses' title");
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE homicides from 2021 to 2025"
  );
  assert.ok(query, "person-count city trend should be deterministic");
  assert.match(query.sql, /summary_victim_city_monthly AS s INDEXED BY idx_svcm_ori/i);
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglary rate from 2000 to 2026"
  );
  assert.equal(query, null, "local rates should stay with the normal model/validator path");
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "shootings in Omaha NE from 2020 to 2026"
  );
  assert.equal(query, null, "shooting/firearm proxy questions should not use the simple count builder");
}
{
  const question = "show me murders for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025";
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(question),
    null,
    "sheriff comparisons must fall through until a unique ORI resolver is available"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Jackson County Sheriff's Office in Missouri and Kansas City Police Department since 2020"),
    null,
    "same-name county sheriff wording must not use substring crosswalk resolution"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Fairfax County Police Department and Arlington Police Department since 2020"),
    null,
    "county-police wording must not be treated as a city name"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Jefferson County Sheriff's Office in Alabama and Birmingham Police Department since 2020"),
    null,
    "an accompanying state must remain disambiguation rather than creating an unsafe sheriff plan"
  );
}

{
  const query = buildNibrsStructuredLocalTrendQuery("compare murders in Houston and Dallas by year since 2020");
  assert.ok(query, "multi-city annual comparison should be deterministic");
  assert.match(query.sql, /city = 'HOUSTON'/i);
  assert.match(query.sql, /city = 'DALLAS'/i);
  assert.equal(query.sql.match(/ORDER BY primary_agency\.pop_group/gi)?.length, 2);
  assert.equal(query.yAxis, "houston_tx_murders,dallas_tx_murders");
  /*
   * THE CITY PATH THROUGH THE PRE-EXECUTION GUARD.
   *
   * The guarded assertions further down build from a resolution plan, whose target list is literal
   * and reads no table. This path is the other one: `target_places` selects its supplied place key
   * and label FROM `agencies`. A checker change that refuses any supplied value beside a real table
   * breaks exactly this query and nothing the plan-based tests cover, so it is asserted here
   * against the builder's own output.
   */
  assert.equal(
    deterministicPlanRefusal({
      question: "compare murders in Houston and Dallas by year since 2020",
      source: "nibrs",
      sql: query.sql,
    }),
    null,
    "the pre-execution guard must accept the city-resolved comparison the product delivers"
  );
}

{
  const currentYear = new Date().getFullYear();
  const query = buildNibrsStructuredLocalTrendQuery(
    `compare murders in Chicago and Milwaukee by year from 2018 to ${currentYear}`
  );
  assert.ok(query, "late-adopter count comparison should be deterministic");
  assert.match(query.sql, /requested_years\(year\)/i);
  assert.match(query.sql, /LEFT JOIN nibrs_agency_completeness AS c INDEXED BY idx_nac_ori_year/i);
  assert.match(query.explanation, /Historical counts are left blank unless the agency reported all 12 months/i);

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    `INSERT INTO agencies VALUES ('ILCPD0000', ${currentYear}, 'IL', 'CHICAGO', 'City', 2700000, '1A'), ('WIMPD0000', ${currentYear}, 'WI', 'MILWAUKEE', 'City', 560000, '1B');`,
    `INSERT INTO summary_victim_city_monthly VALUES ('ILCPD0000', 2021, 1, '09A', 370), ('ILCPD0000', 2022, 1, '09A', 700), ('ILCPD0000', ${currentYear}, 1, '09A', 300), ('WIMPD0000', 2018, 1, '09A', 100), ('WIMPD0000', 2019, 1, '09A', 110), ('WIMPD0000', ${currentYear}, 1, '09A', 50);`,
    `INSERT INTO summary_city_monthly VALUES ('ILCPD0000', ${currentYear}, 1, '220', 1), ('WIMPD0000', ${currentYear}, 1, '220', 1);`,
    `INSERT INTO nibrs_agency_completeness VALUES ('ILCPD0000', 2021, 6), ('ILCPD0000', 2022, 12), ('WIMPD0000', 2018, 12), ('WIMPD0000', 2019, 12), ('WIMPD0000', 2020, 12), ('WIMPD0000', 2021, 12), ('WIMPD0000', 2022, 12), ('WIMPD0000', ${currentYear}, 7);`,
  ].join("\n"));
  const rows = db.prepare(query.sql).all() as Record<string, number | null>[];
  db.close();

  const byYear = new Map(rows.map((row) => [row.year, row]));
  assert.equal(byYear.get(2018)?.chicago_il_murders, null, "pre-adoption years must be null, not false zero");
  assert.equal(byYear.get(2021)?.chicago_il_murders, null, "historical partial years must be null");
  assert.equal(byYear.get(2022)?.chicago_il_murders, 700, "complete historical counts remain visible");
  assert.equal(byYear.get(2020)?.milwaukee_wi_murders, 0, "a complete reporting year with no matching offense is a real zero");
  assert.equal(byYear.get(currentYear)?.chicago_il_murders, 300, "current-year summary data remains visible when completeness has not been rebuilt");

  const rateQuery = buildNibrsStructuredLocalTrendQuery("compare murder rates in Houston and Dallas by year from 2024 to 2025");
  assert.ok(rateQuery, "city rate comparisons should remain deterministic");
  assert.match(rateQuery.sql, /months_reported END\) = 12/i);
}

for (const question of [
  "Murder rate for teenagers in Chicago since 2019",
  "Murder rate for elderly residents in Chicago since 2019",
  "Murder rate for the elderly in Chicago since 2019",
  "Women's robbery victimization rate in Chicago",
]) {
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(question),
    null,
    "demographic rate language must never compile as an overall rate: " + question
  );
}

{
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders per 10,000 in Houston and Dallas since 2020"),
    null,
    "non-100k rate scales must stay on the validated model path"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare firearm murders in Houston and Dallas since 2020"),
    null,
    "weapon-qualified comparisons must stay on the validated model path"
  );
}

{
  // Local plan compilation is a pure function of the question: no database, no cache, no state.
  // The structural claim worth gating is that repeated compilation is deterministic. The elapsed
  // time is printed for information only -- the former "500 compilations under one second" gate
  // measured runner speed, not the planner, and is deliberately not a pass/fail condition.
  const question = "compare murders in Houston and Dallas by year since 2020";
  const first = buildNibrsStructuredLocalTrendQuery(question);
  assert.ok(first, "the comparison question must compile to a local plan");
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) {
    assert.deepEqual(buildNibrsStructuredLocalTrendQuery(question), first, "local plan compilation must be deterministic");
  }
  const elapsed = performance.now() - started;
  console.log(`  500 local plan compilations took ${elapsed.toFixed(1)}ms (informational, not gated)`);
}
{
  const query = buildNibrsLocalCityOffenseCountQuery("Omaha NE motor vehicle thefts from 2020 to 2025");
  assert.ok(query, "nested motor-vehicle-theft wording should remain a single deterministic offense");
  assert.match(query.sql, /ucr_offense_code = '240'/i);
  assert.doesNotMatch(query.sql, /23A-23H/i);
}
{
  const countQuery = buildNibrsLocalDemographicQuery("murder victims by race in Houston since 2020");
  assert.ok(countQuery, "local victim race counts should be deterministic");
  assert.equal(countQuery.guardrail, "deterministic-nibrs-local-demographic-count");
  assert.match(countQuery.sql, /summary_victim_demographics AS d INDEXED BY idx_svd_new_ori_year/i);
  assert.equal(countQuery.xAxis, "race");
  assert.equal(countQuery.yAxis, "victims");

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT, victim_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svd_new_ori_year ON summary_victim_demographics(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    "INSERT INTO agencies VALUES ('TXHPD0000', 2024, 'TX', 'HOUSTON', 'City', 2300000, '1A'), ('TXHPD0000', 2025, 'TX', 'HOUSTON', 'City', 2350000, '1A'), ('TX1012400', 2024, 'TX', 'HOUSTON', 'City', 12000, '5'), ('TX1012400', 2025, 'TX', 'HOUSTON', 'City', 12000, '5');",
    "INSERT INTO summary_victim_demographics VALUES ('TXHPD0000', 2024, '09A', 'W', 'M', '25-34', 'N', 10), ('TXHPD0000', 2024, '09A', 'B', 'M', '25-34', 'N', 20), ('TXHPD0000', 2024, '09A', 'U', 'U', 'Unknown', 'U', 5), ('TXHPD0000', 2025, '09A', 'W', 'F', '25-34', 'H', 15), ('TXHPD0000', 2025, '09A', 'B', 'F', '25-34', 'N', 25), ('TXHPD0000', 2025, '09A', '', '', '', '', 2), ('TX1012400', 2024, '09A', 'B', 'M', '25-34', 'N', 999);",
    "INSERT INTO nibrs_agency_completeness VALUES ('TXHPD0000', 2024, 12), ('TXHPD0000', 2025, 12), ('TX1012400', 2024, 12);",
  ].join("\n"));
  const countRows = db.prepare(countQuery.sql).all() as Record<string, number | string>[];
  assert.deepEqual(countRows, [
    { race: "Black or African American", victims: 45 },
    { race: "White", victims: 25 },
    { race: "Unknown", victims: 7 },
  ]);

  const shareQuery = buildNibrsLocalDemographicQuery("what share of murder victims are in each race in Houston since 2020");
  assert.ok(shareQuery, "local victim race shares should be deterministic");
  assert.equal(shareQuery.guardrail, "deterministic-nibrs-local-demographic-share");
  const shareRows = db.prepare(shareQuery.sql).all() as Record<string, number | string>[];
  assert.deepEqual(shareRows, [
    { race: "Black or African American", victims: 45, share_pct: 58.4 },
    { race: "White", victims: 25, share_pct: 32.5 },
    { race: "Unknown", victims: 7, share_pct: 9.1 },
  ]);

  const annualQuery = buildNibrsLocalDemographicQuery("murder victims by race by year in Houston from 2024 to 2025");
  assert.ok(annualQuery, "annual local victim race counts should be deterministic");
  assert.equal(annualQuery.xAxis, "chart_category");
  const annualRows = db.prepare(annualQuery.sql).all() as Record<string, number | string>[];
  assert.equal(annualRows.length, 6);
  assert.equal(annualRows[0].chart_category, "2024 - Black or African American");
  db.close();
}

{
  const offender = buildNibrsLocalDemographicQuery("robbery offenders by sex in Dallas from 2020 to 2025");
  assert.ok(offender);
  assert.match(offender.sql, /summary_offender_demographics AS d INDEXED BY idx_sod_new_ori_year/i);
  assert.match(offender.sql, /SUM\(d\.offender_count\) AS offenders/i);

  const arrestee = buildNibrsLocalDemographicQuery("murder arrestees by age in Dallas from 2020 to 2025");
  assert.ok(arrestee);
  assert.match(arrestee.sql, /summary_arrestee_demographics AS d INDEXED BY idx_sad_new_ori_year/i);
  assert.match(arrestee.sql, /d\.ucr_arrest_offense = '09A'/i);

  const ethnicity = buildNibrsLocalDemographicQuery("robbery victims by ethnicity in Dallas from 2020 to 2025");
  assert.ok(ethnicity);
  assert.match(ethnicity.sql, /Hispanic or Latino/i);

  assert.equal(buildNibrsLocalDemographicQuery("murders by race in Houston since 2020"), null,
    "ambiguous person role must stay on the validated model path");
  assert.equal(buildNibrsLocalDemographicQuery("murder victim rates by race in Houston since 2020"), null,
    "demographic population rates must remain unsupported");
  assert.equal(buildNibrsLocalDemographicQuery("firearm murder victims by race in Houston since 2020"), null,
    "weapon-qualified demographics require the existing specialized path");
  assert.equal(buildNibrsLocalDemographicQuery("murder victims by race and sex in Houston since 2020"), null,
    "multi-dimensional demographics stay on the validated model path initially");
}

{
  const whitePlainsRate = buildNibrsStructuredLocalTrendQuery(
    "What is the aggravated assault rate in White Plains, NY?"
  );
  assert.ok(whitePlainsRate, "single-city overall rates should default to five complete years");
  assert.equal(whitePlainsRate.guardrail, "deterministic-nibrs-structured-local-rate");
  assert.match(whitePlainsRate.sql, /city = 'WHITE PLAINS'/i);
  assert.match(whitePlainsRate.sql, /s\.ucr_offense_code = '13A'/i);

  const sexOffenseRate = buildNibrsStructuredLocalTrendQuery(
    "Sex offense rates in Denver since 2019"
  );
  assert.ok(sexOffenseRate, "sex-offense category rates must not be treated as demographic rates");
  assert.match(sexOffenseRate.sql, /s\.ucr_offense_code IN \('11A','11B','11C','11D','36A','36B'\)/i);
  assert.doesNotMatch(sexOffenseRate.explanation, /demographic population/i);
  assert.match(sexOffenseRate.explanation, /forcible and nonforcible.*statutory rape/i);
}

// --- Production 8388: clearances by type must include the uncleared remainder ---
// The model answered with a "Cleared by Arrest" row holding every measure and a
// "Not Cleared" row of literal zeros. Las Vegas 2025 is 82 = 62 + 11 + 9. These
// tests run the generated SQL rather than pattern-matching it, because the bug
// was a plausible-looking query that returned wrong numbers.
{
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
    CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
    CREATE TABLE summary_clearance_detail (year INTEGER, state TEXT, ori TEXT, ucr_offense_code TEXT,
      cleared_by_arrest INTEGER, cleared_A INTEGER, cleared_B INTEGER, cleared_C INTEGER,
      cleared_D INTEGER, cleared_E INTEGER, total_offenses INTEGER);
    CREATE INDEX idx_scd_ori_year ON summary_clearance_detail(ori, year);
    CREATE INDEX idx_scd_state_year ON summary_clearance_detail(state, year);
    INSERT INTO agencies VALUES
      ('NV0020100', 2025, 'NV', 'LAS VEGAS', 'City', 1712136, '1A', 'N', 'E'),
      ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E');
    INSERT INTO summary_clearance_detail VALUES
      (2025, 'NV', 'NV0020100', '09A', 62, 11, 0, 0, 0, 0, 82),
      (2025, 'IL', 'ILCPD0000', '09A', 62, 0, 0, 0, 0, 0, 321);
  `);

  const q = "las vegas murder clearances by type of clearance in 2025";
  const built = buildNibrsClearanceTypeBreakdownQuery(q, resolveNibrsPlaces(db, q));
  assert.ok(built, "8388's phrasing must reach a deterministic builder");
  assert.equal(built.guardrail, "deterministic-nibrs-clearance-type-breakdown");
  assert.match(built.sql, /scd\.ori IN \('NV0020100'\)/);

  const rows = db.prepare(built.sql).all() as { year: number; clearance_type: string; offenses: number }[];
  const byType = new Map(rows.map((r) => [r.clearance_type, r.offenses]));
  assert.equal(byType.get("Cleared by arrest"), 62);
  assert.equal(byType.get("Death of offender"), 11);
  assert.equal(byType.get("Not cleared"), 9, "the uncleared remainder is derived, not assumed to be zero");
  assert.equal(
    rows.reduce((sum, r) => sum + r.offenses, 0),
    82,
    "categories must sum to the reported total, or the chart lies about the whole"
  );
  assert.equal(rows[0].clearance_type, "Cleared by arrest", "categories come back in a stable order");
  assert.equal(rows[rows.length - 1].clearance_type, "Not cleared");

  // Phrasing variants that name "type" reach the same builder
  for (const variant of [
    "murder clearances by type in Las Vegas, NV in 2025",
    "murder clearance types in Las Vegas, NV in 2025",
    "murder clearances by type of clearance in Las Vegas, NV in 2025",
    "break down murder clearances by type in Las Vegas, NV in 2025",
    "clearances for murder by type in Las Vegas, NV in 2025",
  ]) {
    assert.ok(
      buildNibrsClearanceTypeBreakdownQuery(variant, resolveNibrsPlaces(db, variant)),
      `variant must build: ${variant}`
    );
  }

  // Requests that say "breakdown" without naming type are ambiguous -- by city,
  // by agency and by year are all common -- so this builder must not claim them.
  for (const other of [
    "breakdown of murder clearances in Las Vegas, NV in 2025",
    "murder clearances by city in Nevada in 2025",
    "murder clearances by year in Las Vegas, NV",
  ]) {
    assert.equal(
      buildNibrsClearanceTypeBreakdownQuery(other, resolveNibrsPlaces(db, other)),
      null,
      `must not claim an ambiguous or differently-grouped request: ${other}`
    );
  }

  // Same guards as the sibling builder: one place, and a resolved agency
  const multi = "murder clearances by type for Chicago, IL and Las Vegas, NV in 2025";
  assert.equal(
    buildNibrsClearanceTypeBreakdownQuery(multi, resolveNibrsPlaces(db, multi)),
    null,
    "multi-place requests go to the model path, not to a single-geography builder"
  );
  assert.equal(buildNibrsClearanceTypeBreakdownQuery(q, null), null, "no resolved agency means no deterministic query");
  db.close();
}

/*
 * THE BUILDER AND THE SAFETY CHECKER MUST AGREE ON A SUPPORTED ANSWER.
 *
 * A multi-agency, multi-offence annual comparison was built correctly and then refused before
 * execution: each per-offence branch carries a constant label beside its measure, and a constant
 * had no traceable origin, so every returned series was reported unresolved. The plan was thrown
 * away and the question fell to the model.
 *
 * These do not check the label. They check that a built plan survives the guard that actually runs
 * in the route, that the figures it returns are the figures the fixture holds, and that the checks
 * which should still refuse a query still do. The names are varied deliberately: a proof that
 * passes by recognising GC-083 proves nothing.
 */
{
  const witness = "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025";
  const planFor = (oris: [string, string], labels: [string, string], years: number[]) => ({
    elapsedMs: 0,
    hasStateComparison: false,
    places: [0, 1].map((i) => ({
      contractIndex: i,
      kind: i === 0 ? "city_police" : "sheriff",
      status: "resolved",
      label: labels[i],
      oriYears: years.map((year) => ({ ori: oris[i], year })),
      population: null,
    })),
  }) as never;

  const built = buildNibrsStructuredLocalTrendQuery(
    witness, planFor(["NM0010100", "NM0010000"], ["Albuquerque Police Department", "Bernalillo County Sheriff"], [2020, 2021, 2022, 2023, 2024, 2025])
  );
  assert.ok(built, "the supported multi-agency annual comparison must still build");
  assert.equal(
    deterministicPlanRefusal({ question: witness, source: "nibrs", sql: built!.sql }),
    null,
    "and the structural guard that runs before execution must accept it"
  );

  // Different agencies, different offence order, different years: the agreement is about the
  // shape, not about these names.
  const other = "compare aggravated assaults, murders and robberies for dallas police department and harris county sheriff by year for 2021 to 2023";
  const otherBuilt = buildNibrsStructuredLocalTrendQuery(
    other, planFor(["TX0570000", "TX1010000"], ["Dallas Police Department", "Harris County Sheriff"], [2021, 2022, 2023])
  );
  assert.ok(otherBuilt, "the same shape must build for other agencies and offence orderings");
  assert.equal(
    deterministicPlanRefusal({ question: other, source: "nibrs", sql: otherBuilt!.sql }),
    null,
    "and must be accepted on its own terms, not by matching the witness"
  );

  /*
   * EXECUTION AND DELIVERY, THROUGH THE FUNCTIONS THE ROUTE ACTUALLY USES.
   *
   * Building a query and asserting rows proves the SQL. It does not prove the answer: the route
   * runs the pre-execution guard, executes, then passes the result through disclosure, grain and
   * title alignment before anything reaches a reader. This drives that same chain in-process —
   * `deterministicPlanRefusal` -> execute -> `applyResultDisclosures` -> `validateGrain` ->
   * `alignTitleYearRange` — and asserts the delivered figures, both agency identities, the offence
   * labels, the period, the explanation and the title.
   *
   * Every figure is distinct, so a swapped agency, offence or year cannot pass unnoticed. The
   * decoys are the mistakes this shape invites: a third agency in the same state, a neighbouring
   * year, an offence code nobody asked for, and — the one the split-table design risks —
   * duplicate completeness rows that would multiply a measure through its join.
   */
  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    // Murders (victim table) — distinct per agency and year.
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'09A',11),('NM0010100',2021,1,'09A',12),('NM0010000',2020,1,'09A',21),('NM0010000',2021,1,'09A',22);",
    // Aggravated assaults (victim table) — deliberately far from the murder values.
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'13A',311),('NM0010100',2021,1,'13A',312),('NM0010000',2020,1,'13A',321),('NM0010000',2021,1,'13A',322);",
    // Robberies (offence table) — a different table and column entirely.
    "INSERT INTO summary_city_monthly VALUES ('NM0010100',2020,1,'120',411),('NM0010100',2021,1,'120',412),('NM0010000',2020,1,'120',421),('NM0010000',2021,1,'120',422);",
    // DECOYS. A third agency, an unrequested offence, and a year outside the range.
    "INSERT INTO summary_victim_city_monthly VALUES ('NM9999999',2020,1,'09A',9999),('NM0010100',2020,1,'11A',8888),('NM0010100',2019,1,'09A',7777);",
    "INSERT INTO summary_city_monthly VALUES ('NM9999999',2020,1,'120',6666);",
    // Completeness for both years, both agencies. The duplicate row is the multiplication trap:
    // a join that fans out would double every measure for that agency-year.
    "INSERT INTO nibrs_agency_completeness VALUES ('NM0010100',2020,12),('NM0010100',2021,12),('NM0010000',2020,12),('NM0010000',2021,12),('NM0010100',2020,12);",
  ].join("\n"));

  const twoYearQuestion = "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2021";
  const twoYear = buildNibrsStructuredLocalTrendQuery(
    twoYearQuestion,
    planFor(["NM0010100", "NM0010000"], ["Albuquerque Police Department", "Bernalillo County Sheriff"], [2020, 2021])
  );
  assert.ok(twoYear, "the two-year witness must build");

  // THE SAME query that is executed must be the one the guard passed.
  assert.equal(
    deterministicPlanRefusal({ question: twoYearQuestion, source: "nibrs", sql: twoYear!.sql }),
    null,
    "the executed query must be the one the pre-execution guard accepted"
  );

  const rawRows = db.prepare(twoYear!.sql).all() as Record<string, unknown>[];
  const rows = normalizeConsolidatedDisplayRows(rawRows) as Record<string, number | null>[];
  // The route additionally normalises city-like columns; this shape returns none, asserted rather
  // than assumed, so that step is a no-op here.
  const columns = Object.keys(rows[0] ?? {});
  for (const cityLike of ["city", "agency", "agency_name", "jurisdiction"]) {
    assert.ok(!columns.includes(cityLike), `this shape returns no ${cityLike} column`);
  }

  const byYear = new Map(rows.map((row) => [row.year, row]));
  assert.deepEqual([...byYear.keys()].sort(), [2020, 2021], "exactly the requested years are returned");

  const y2020 = byYear.get(2020)!;
  const y2021 = byYear.get(2021)!;
  const col = (label: string, offense: string) => `${label}_${offense}`;
  const abq = "albuquerque_police_department";
  const bcs = "bernalillo_county_sheriff";

  // ALL TWELVE seeded cells, each asserted explicitly: two agencies x three offences x two years.
  const expected: Array<[string, string, number, number]> = [
    [abq, "murders", 11, 12], [bcs, "murders", 21, 22],
    [abq, "aggravated_assaults", 311, 312], [bcs, "aggravated_assaults", 321, 322],
    [abq, "robberies", 411, 412], [bcs, "robberies", 421, 422],
  ];
  for (const [agency, offense, v2020, v2021] of expected) {
    assert.equal(y2020[col(agency, offense)], v2020, `${agency} ${offense} 2020`);
    assert.equal(y2021[col(agency, offense)], v2021, `${agency} ${offense} 2021`);
  }

  // The decoys must not appear anywhere in the result.
  const everyValue = rows.flatMap((row) => Object.values(row));
  for (const decoy of [9999, 8888, 7777, 6666]) {
    assert.ok(!everyValue.includes(decoy),
      `a decoy figure (${decoy}) reached the answer: wrong agency, offence or year`);
  }
  // The duplicate completeness row must not have doubled anything.
  assert.equal(y2020[col(abq, "murders")], 11, "a duplicate completeness row must not multiply a measure");
  assert.equal(y2020[col(abq, "robberies")], 411, "including across the offence table");

  /*
   * DELIVERY. What a reader is actually handed, through the route's own functions.
   */
  const delivered = applyResultDisclosures({
    explanation: twoYear!.explanation,
    question: twoYearQuestion,
    sql: twoYear!.sql,
    rows,
    tab: "nibrs",
    resultState: genericResultState({ sql: twoYear!.sql, rows }),
  });
  const grain = validateGrain(twoYearQuestion, rows, twoYear!.sql);
  assert.ok(grain.ok, `the delivered grain must match the request: ${grain.message ?? ""}`);
  const title = alignTitleYearRange(twoYear!.title, rows);

  // Both agency identities survive to the reader, separately.
  for (const name of ["Albuquerque Police Department", "Bernalillo County Sheriff"]) {
    assert.ok(delivered.includes(name), `the delivered explanation must name ${name}`);
    assert.ok(title.includes(name), `the delivered title must name ${name}`);
  }
  // The offences are named, and the source split is disclosed rather than implied.
  for (const offense of ["murders", "robberies", "aggravated assaults"]) {
    assert.ok(delivered.toLowerCase().includes(offense), `the explanation must name ${offense}`);
  }
  assert.match(delivered, /victim summaries/i, "the victim/offence table split must be disclosed");
  // The completeness rule that can withhold a year must be stated, not silent.
  assert.match(delivered, /all 12 months/i, "the 12-month completeness rule must be disclosed");

  /*
   * WITHHELD YEAR. An agency reporting 11 of 12 months must have that year left blank and
   * explained — never converted to a zero, and never counted as a complete comparison.
   */
  const partialDb = new Database(":memory:");
  partialDb.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'09A',11),('NM0010100',2021,1,'09A',12),('NM0010000',2020,1,'09A',21),('NM0010000',2021,1,'09A',22);",
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'13A',311),('NM0010100',2021,1,'13A',312),('NM0010000',2020,1,'13A',321),('NM0010000',2021,1,'13A',322);",
    "INSERT INTO summary_city_monthly VALUES ('NM0010100',2020,1,'120',411),('NM0010100',2021,1,'120',412),('NM0010000',2020,1,'120',421),('NM0010000',2021,1,'120',422);",
    // 2021 is one month short for BOTH agencies: the data exists and must still be withheld.
    "INSERT INTO nibrs_agency_completeness VALUES ('NM0010100',2020,12),('NM0010100',2021,11),('NM0010000',2020,12),('NM0010000',2021,11);",
  ].join("\n"));
  const partialRows = partialDb.prepare(twoYear!.sql).all() as Record<string, number | null>[];
  partialDb.close();
  const p2021 = new Map(partialRows.map((row) => [row.year, row])).get(2021)!;
  for (const [agency, offense] of [[abq, "murders"], [bcs, "murders"], [abq, "robberies"], [bcs, "aggravated_assaults"]] as const) {
    assert.equal(p2021[col(agency, offense)], null,
      `an incomplete year must be withheld, not published: ${agency} ${offense}`);
    assert.notEqual(p2021[col(agency, offense)], 0,
      `and must never be converted to a zero: ${agency} ${offense}`);
  }
  const p2020 = new Map(partialRows.map((row) => [row.year, row])).get(2020)!;
  assert.equal(p2020[col(abq, "murders")], 11, "the complete year beside it is unaffected");

  /*
   * MISSING MEMBER. An agency with no rows at all must not silently vanish from a comparison the
   * explanation still describes as covering both.
   */
  const missingDb = new Database(":memory:");
  missingDb.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    // Only the first agency reports anything.
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'09A',11);",
    "INSERT INTO nibrs_agency_completeness VALUES ('NM0010100',2020,12),('NM0010000',2020,12);",
  ].join("\n"));
  const missingRows = missingDb.prepare(twoYear!.sql).all() as Record<string, number | null>[];
  missingDb.close();
  const m2020 = new Map(missingRows.map((row) => [row.year, row])).get(2020)!;
  assert.equal(m2020[col(abq, "murders")], 11, "the reporting agency still delivers its figure");
  assert.equal(m2020[col(bcs, "murders")], 0,
    "an agency that reported a complete year with no matching offence is a real zero");
  // The absent member must still be a named column rather than disappearing from the shape.
  assert.ok(Object.keys(m2020).includes(col(bcs, "murders")),
    "a member with no data must remain a named column, not vanish from the comparison");
}

/*
 * THE BUILDER'S OWN BOUNDARIES, THROUGH THE GUARD AND THROUGH DELIVERY.
 *
 * The offence identity now lives in a relation's name rather than in a projected label, so the
 * pre-execution guard accepts what the builder produces without the checker being widened. These
 * exercise ACTUAL builder output at the edges of the supported family, not a hand-written shape.
 */
{
  const planFor = (oris: string[], labels: string[], years: number[], kinds: string[]) => ({
    elapsedMs: 0,
    hasStateComparison: false,
    places: oris.map((ori, i) => ({
      contractIndex: i, kind: kinds[i], status: "resolved", label: labels[i],
      oriYears: years.map((year) => ({ ori, year, population: 500000 })), population: 500000,
    })),
  }) as never;

  const guarded = (question: string, plan: unknown) => {
    const built = buildNibrsStructuredLocalTrendQuery(question, plan as never);
    if (!built) return null;
    assert.equal(
      deterministicPlanRefusal({ question, source: "nibrs", sql: built.sql }),
      null,
      `the pre-execution guard must accept the builder's own output: ${question}`
    );
    return built;
  };

  // One agency, several offences.
  const oneAgency = guarded(
    "show me murders, robberies and aggravated assaults for albuquerque police department by year for 2020 to 2021",
    planFor(["NM0010100"], ["Albuquerque Police Department"], [2020, 2021], ["city_police"])
  );
  assert.ok(oneAgency, "one agency with several offences is a supported comparison");

  // Several agencies, one offence.
  const oneOffense = guarded(
    "compare murders for albuquerque police department and bernalillo county sheriff by year for 2020 to 2021",
    planFor(["NM0010100", "NM0010000"], ["Albuquerque Police Department", "Bernalillo County Sheriff"], [2020, 2021], ["city_police", "sheriff"])
  );
  assert.ok(oneOffense, "several agencies with one offence is a supported comparison");

  // A rate, with its own denominator and completeness rule.
  const rate = guarded(
    "compare murder rates per 100k for albuquerque police department and bernalillo county sheriff by year for 2020 to 2021",
    planFor(["NM0010100", "NM0010000"], ["Albuquerque Police Department", "Bernalillo County Sheriff"], [2020, 2021], ["city_police", "sheriff"])
  );
  assert.ok(rate, "the supported rate output must still build");
  assert.match(rate!.sql, /100000\.0 \*/, "a rate divides by a population denominator");
  assert.match(rate!.sql, /NULLIF\(MAX\(CASE WHEN pr\.place_key/, "and yields null rather than dividing by zero");
  assert.match(rate!.sql, /pr\.population/, "using the year-specific population the reporting CTE carries");

  // Boundaries the builder refuses, unchanged by this work.
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(
      "murders by month for albuquerque police department and bernalillo county sheriff in 2020",
      planFor(["NM0010100", "NM0010000"], ["A", "B"], [2020], ["city_police", "sheriff"])
    ),
    null,
    "month breakdowns stay on the validated model path"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(
      "how many murders in albuquerque police department in 2020",
      planFor(["NM0010100"], ["Albuquerque Police Department"], [2020], ["city_police"])
    ),
    null,
    "a single agency with a single offence count is not this family"
  );

  /*
   * UNAVAILABLE REPORTING IS NULL AND EXPLAINED — and is NOT the covered zero above.
   * The earlier fixture gave the silent agency a complete-year completeness row, which makes its
   * zero real. Here the agency has no completeness record at all: nothing establishes that it
   * reported, so the answer must withhold rather than publish a zero.
   */
  const q = "compare murders for albuquerque police department and bernalillo county sheriff by year for 2020 to 2021";
  const built = oneOffense!;
  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100',2020,1,'09A',11),('NM0010100',2021,1,'09A',12);",
    // Only the first agency has any completeness record. The second is unestablished, not empty.
    "INSERT INTO nibrs_agency_completeness VALUES ('NM0010100',2020,12),('NM0010100',2021,12);",
  ].join("\n"));
  const rows = normalizeConsolidatedDisplayRows(db.prepare(built.sql).all() as Record<string, unknown>[]) as Record<string, number | null>[];
  db.close();

  const y2020 = new Map(rows.map((r) => [r.year, r])).get(2020)!;
  assert.equal(y2020.albuquerque_police_department_murders, 11, "the reporting agency delivers its figure");
  assert.equal(y2020.bernalillo_county_sheriff_murders, null,
    "an agency with NO reporting record must be withheld, not published as zero");
  assert.notEqual(y2020.bernalillo_county_sheriff_murders, 0,
    "and must never be converted to a zero");

  // The incomplete counterpart goes through delivery too, not just raw rows.
  const delivered = applyResultDisclosures({
    explanation: built.explanation, question: q, sql: built.sql, rows, tab: "nibrs",
    resultState: genericResultState({ sql: built.sql, rows }),
  });
  const title = alignTitleYearRange(built.title, rows);
  for (const name of ["Albuquerque Police Department", "Bernalillo County Sheriff"]) {
    assert.ok(delivered.includes(name), `the withheld agency must still be named: ${name}`);
    assert.ok(title.includes(name), `and named in the title: ${name}`);
  }
  assert.match(delivered, /all 12 months/i,
    "and the rule that withheld it must be stated in the delivered explanation");
  assert.ok(validateGrain(q, rows, built.sql).ok, "the incomplete counterpart still matches the requested grain");
}

/*
 * A NAMED AGENCY'S DEMOGRAPHIC ANSWER, END TO END.
 *
 * The saved GC-084 response was refused in 2 ms because the request contained the word `county` —
 * inside the agency's own name. The whole downstream path already worked: the contract resolved it
 * as an agency, and this builder produces a complete answer. Only the misclassification stood in
 * the way, which a city agency proved by being answered all along.
 *
 * These drive actual builder output through the pre-execution guard, a schema-faithful fixture and
 * the production delivery functions, and assert the figures, the agency identity, the period, the
 * explanation and the title. The decoys are the substitutions this shape invites.
 */
{
  const question = "show me murders by offender age for worcester county, md sheriff's office from 2022 to 2025";
  const years = [2022, 2023, 2024, 2025];
  const sheriffPlan = {
    elapsedMs: 0, hasStateComparison: false,
    places: [{
      contractIndex: 0, kind: "sheriff", status: "resolved", label: "Worcester County Sheriff's Office",
      oriYears: years.map((year) => ({ ori: "MD0240000", year, population: 52000 })), population: 52000,
    }],
  } as never;

  const built = buildNibrsLocalDemographicQuery(question, sheriffPlan);
  assert.ok(built, "a named sheriff agency's demographic request must build");
  assert.equal(
    deterministicPlanRefusal({ question, source: "nibrs", sql: built!.sql }),
    null,
    "and the pre-execution guard must accept the builder's own output"
  );

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE summary_offender_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_sod_new_ori_year ON summary_offender_demographics(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    // The requested agency: a distinct figure per age band.
    "INSERT INTO summary_offender_demographics VALUES ('MD0240000',2022,'09A','25-34',31),('MD0240000',2023,'09A','25-34',32),('MD0240000',2022,'09A','18-24',21),('MD0240000',2023,'09A','35-44',43);",
    // DECOYS: a different agency, a different offence, a year outside the request, and a year the
    // agency did not report completely.
    "INSERT INTO summary_offender_demographics VALUES ('MD0240300',2022,'09A','25-34',9999);",
    "INSERT INTO summary_offender_demographics VALUES ('MD0240000',2022,'120','25-34',8888);",
    "INSERT INTO summary_offender_demographics VALUES ('MD0240000',2019,'09A','25-34',7777);",
    "INSERT INTO summary_offender_demographics VALUES ('MD0240000',2024,'09A','25-34',6666);",
    // 2024 is deliberately incomplete, so its rows must be excluded rather than counted.
    "INSERT INTO nibrs_agency_completeness VALUES ('MD0240000',2022,12),('MD0240000',2023,12),('MD0240000',2024,11),('MD0240300',2022,12);",
  ].join("\n"));
  const rows = normalizeConsolidatedDisplayRows(db.prepare(built!.sql).all() as Record<string, unknown>[]) as Record<string, unknown>[];
  db.close();

  const byBand = new Map(rows.map((r) => [String(r.age_group), Number(r.offenders)]));
  assert.equal(byBand.get("25-34"), 63, "the requested agency's complete years are summed (31 + 32)");
  assert.equal(byBand.get("18-24"), 21, "each age band keeps its own figure");
  assert.equal(byBand.get("35-44"), 43);
  for (const decoy of [9999, 8888, 7777, 6666]) {
    assert.ok(![...byBand.values()].includes(decoy),
      `a decoy reached the answer (${decoy}): wrong agency, offence, year or an incomplete year`);
  }

  const delivered = applyResultDisclosures({
    explanation: built!.explanation, question, sql: built!.sql, rows, tab: "nibrs",
    resultState: genericResultState({ sql: built!.sql, rows }),
  });
  const title = alignTitleYearRange(built!.title, rows);
  assert.ok(delivered.includes("Worcester County Sheriff's Office"),
    "the delivered explanation must name the agency actually queried");
  assert.ok(title.includes("Worcester County Sheriff's Office"),
    "and so must the title");
  assert.ok(!/countywide|all agencies/i.test(delivered),
    "and must never describe one agency's figures as a countywide total");
  /*
   * PERIOD AND REPORTING QUALIFICATION, as they actually are.
   *
   * The answer states the requested period and the completeness rule that governs which years can
   * contribute. It does NOT enumerate the contributing years, nor name 2024 as omitted — asserting
   * that would claim a disclosure the product does not make. Pinned as the existing qualified-period
   * behaviour so a future change to it is deliberate.
   */
  assert.match(delivered, /for the requested years/i,
    "the delivered explanation states the requested period");
  assert.match(delivered, /complete 12-month reporting years/i,
    "and the reporting qualification that decides which years contribute");
  assert.ok(!/2024/.test(delivered),
    "existing behaviour does not identify the omitted year; this pins that, it does not endorse it");
  assert.match(built!.guardrail, /deterministic-nibrs-local-demographic/,
    "the answer is delivered by the deterministic demographic path");

  // Varied names, so nothing passes by recognising this one. The second is EXECUTED and DELIVERED
  // as well as built, so the varied-name claim is not merely a construction check.
  for (const [place, ori, kind, execute] of [
    ["bernalillo county sheriff", "NM0010000", "sheriff", true],
    ["nassau county police department", "NY0300000", "sheriff", false],
    ["pocomoke city, md police department", "MD0240300", "city_police", false],
  ] as const) {
    const q2 = `show me robberies by offender age for ${place} from 2022 to 2023`;
    const b2 = buildNibrsLocalDemographicQuery(q2, {
      elapsedMs: 0, hasStateComparison: false,
      places: [{
        contractIndex: 0, kind, status: "resolved", label: place,
        oriYears: [2022, 2023].map((year) => ({ ori, year, population: 40000 })), population: 40000,
      }],
    } as never);
    assert.ok(b2, `a named agency must build regardless of its name: ${place}`);
    assert.equal(
      deterministicPlanRefusal({ question: q2, source: "nibrs", sql: b2!.sql }),
      null,
      `and be accepted by the guard: ${place}`
    );
    if (!execute) continue;

    const vdb = new Database(":memory:");
    vdb.exec([
      "CREATE TABLE summary_offender_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER);",
      "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
      "CREATE INDEX idx_sod_new_ori_year ON summary_offender_demographics(ori, year);",
      "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
      `INSERT INTO summary_offender_demographics VALUES ('${ori}',2022,'120','18-24',17),('${ori}',2023,'120','18-24',18),('${ori}',2022,'120','45-54',55);`,
      `INSERT INTO summary_offender_demographics VALUES ('ZZ9999999',2022,'120','18-24',4242);`,
      `INSERT INTO nibrs_agency_completeness VALUES ('${ori}',2022,12),('${ori}',2023,12),('ZZ9999999',2022,12);`,
    ].join("\n"));
    const vrows = normalizeConsolidatedDisplayRows(vdb.prepare(b2!.sql).all() as Record<string, unknown>[]) as Record<string, unknown>[];
    vdb.close();
    const vBands = new Map(vrows.map((r) => [String(r.age_group), Number(r.offenders)]));
    assert.equal(vBands.get("18-24"), 35, `a second named agency delivers its own figures: ${place}`);
    assert.equal(vBands.get("45-54"), 55);
    assert.ok(![...vBands.values()].includes(4242), "another agency's rows must not reach it");
    const vDelivered = applyResultDisclosures({
      explanation: b2!.explanation, question: q2, sql: b2!.sql, rows: vrows, tab: "nibrs",
      resultState: genericResultState({ sql: b2!.sql, rows: vrows }),
    });
    assert.ok(vDelivered.toLowerCase().includes(place.split(",")[0].toLowerCase()),
      `and is named in its delivered explanation: ${place}`);
  }

  /*
   * UNAVAILABLE REPORTING IS NOT A ZERO.
   *
   * An agency with no completeness record contributes no rows at all, because the builder's
   * completeness predicate requires a complete 12-month year. The answer must therefore be EMPTY —
   * never a zero, and never a band showing 0 as if it had been measured.
   */
  const unavailableDb = new Database(":memory:");
  unavailableDb.exec([
    "CREATE TABLE summary_offender_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_sod_new_ori_year ON summary_offender_demographics(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    // The agency has demographic rows but NO completeness record: reporting is unestablished.
    "INSERT INTO summary_offender_demographics VALUES ('MD0240000',2022,'09A','25-34',31);",
  ].join("\n"));
  const unavailableRows = unavailableDb.prepare(built!.sql).all() as Record<string, unknown>[];
  unavailableDb.close();
  assert.equal(unavailableRows.length, 0,
    "unestablished reporting yields no rows; it must never be presented as a measured zero");
  assert.ok(!unavailableRows.some((r) => Number(r.offenders) === 0),
    "and no band may appear with a zero it did not earn");

  // The shapes that must NOT be answered here, so a removed refusal is not mistaken for delivery.
  assert.equal(
    buildNibrsLocalDemographicQuery(
      "show me murders by offender age for worcester county, md from 2022 to 2023",
      sheriffPlan
    ),
    null,
    "a bare county name is not an agency request and must not be answered by this builder"
  );
  /*
   * TWO NAMED AGENCIES, with ONE RECOGNISED OFFENCE so the boundary is isolated. The earlier form
   * used "violent crimes", which then mapped to no offence codes (the plural is recognised since the
   * GC-084 batch) and would have declined on its own — proving nothing about the two-agency limit.
   *
   * The boundary itself changed on 2026-09-26 (Codex GC-084/GC-098 design ruling): this used to
   * assert a two-agency request is declined, so one agency's figures could never answer for both.
   * Offender age-group counts for 2-5 resolver-bound agencies are now built with one declared
   * column per agency, so the guarantee is asserted directly: both agencies, each its own column,
   * never one agency answering for both. Everything outside that bound is still declined
   * (scripts/test-owned-demographic-comparison.ts).
   */
  const twoAgencyQ = "show me murders by offender age for worcester county, md sheriff's office and pocomoke city, md police department";
  const twoAgencyContract = buildQueryContract(twoAgencyQ, "nibrs");
  assert.ok(twoAgencyContract, "the two-agency contract must build");
  assert.equal(twoAgencyContract!.metric.offenses.length, 1,
    "the offence is recognised, so only the agency count can be what declines this");
  assert.equal(twoAgencyContract!.geographies.length, 2, "and two agencies are resolved");
  const twoAgency = buildNibrsLocalDemographicQuery(twoAgencyQ, {
    elapsedMs: 0, hasStateComparison: false,
    places: [
      { contractIndex: 0, kind: "sheriff", status: "resolved", label: "Worcester County Sheriff's Office",
        oriYears: years.map((year) => ({ ori: "MD0240000", year, population: 52000 })), population: 52000 },
      { contractIndex: 1, kind: "city_police", status: "resolved", label: "Pocomoke City Police Department",
        oriYears: years.map((year) => ({ ori: "MD0240300", year, population: 4000 })), population: 4000 },
    ],
  } as never);
  assert.ok(twoAgency, "two resolver-bound agencies get the application-built answer");
  assert.deepEqual(twoAgency!.memberColumns?.map((member) => [member.contractIndex, member.placeLabel]),
    [[0, "Worcester County Sheriff's Office"], [1, "Pocomoke City Police Department"]],
    "one declared column per agency, never one agency answering for both");
  assert.ok(twoAgency!.sql.includes("'MD0240000'") && twoAgency!.sql.includes("'MD0240300'"),
    "both agencies' own ORIs are in the statement");
}

// COVER batch (Codex :34982): the withheld-rate note states only established reasons, names sorted observed
// activity months as a proxy, labels a multi-ORI union, never infers January-through-N, and metadata never ships.
{
  const plan = {
    memberColumns: [{ placeKey: "place_1", column: "x_rate" }],
    metadataColumns: [{ placeKey: "place_1", placeLabel: "Union City, NJ", monthsReported: "m_mr", population: "m_pop", activityMonths: "m_am", activityOris: "m_ao" }],
  } as never;
  const note = (row: Record<string, unknown>) => nibrsWithheldRateNote(plan, [{ year: 2026, x_rate: null, ...row }]);
  assert.equal(note({ m_mr: 9, m_pop: 1000, m_am: "7,1,3,13,0,3", m_ao: 2 }),
    "Union City, NJ, 2026: the rate is left blank because the NIBRS completeness record shows 9 of 12 months reported for 2026, and a rate is shown only for a year with all 12. Summary data show offense activity in January, March, July (across its 2 agency records combined); months with recorded offenses are a proxy, not certified reporting coverage.",
    "sorted distinct valid months; a multi-ORI union is labelled; no January-through inference");
  assert.match(note({ m_mr: null, m_pop: 1000, m_am: "", m_ao: 0 })!, /has no months-reported entry for 2026.*Summary data show no offense activity for 2026\.$/);
  assert.match(note({ m_mr: 12, m_pop: null, m_am: "1,2", m_ao: 1 })!, /because no service population is recorded for 2026\. Summary data show offense activity in January, February;/);
  assert.match(note({ m_mr: 12, m_pop: 1000, m_am: "1", m_ao: 1 })!, /because the reason is not established from the returned evidence\./, "unknown causes stay unknown");
  assert.equal(nibrsWithheldRateNote(plan, [{ year: 2026, x_rate: 4.2, m_mr: 9, m_pop: 1000, m_am: "1", m_ao: 1 }]), null, "a shown rate gets no note");
  assert.equal(nibrsWithheldRateNote({ memberColumns: [{ placeKey: "place_1", column: "x_rate" }] } as never, [{ year: 2026, x_rate: null }]), null, "no metadata, no note");
  const delivered = withoutNibrsMetadata(plan, ["year", "x_rate", "m_mr", "m_pop", "m_am", "m_ao"], [{ year: 2026, x_rate: null, m_mr: 9, m_pop: 1, m_am: "1", m_ao: 1 }]);
  assert.deepEqual(delivered, { columns: ["year", "x_rate"], rows: [{ year: 2026, x_rate: null }] }, "metadata is removed from delivered rows and columns");
}

console.log("nibrs deterministic query tests passed");
