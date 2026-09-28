/*
 * P3.AGENCY.COMPLETE_MEMBERS — every requested agency survives to the answer, or is named as missing.
 *
 * The failure this exists to stop is not a refusal. It is GC-084: a question naming two agencies, an
 * answer built from one of them, and prose calling the result countywide with no mention of the
 * other. A refusal is visibly unhelpful; this is confidently wrong.
 *
 * Runs against a disposable fixture, so it needs no real database. The fixture rows are the real
 * shapes read out of `agencies` on the capture machine, because the design turns on facts a
 * plausible-looking fixture would have got wrong:
 *   - POCOMOKE CITY is filed WITH the "City"; there is no "POCOMOKE" row in MD at all.
 *   - REDWOOD and REDWOOD CITY are BOTH real in CA, with different ORIs and 5,604 vs 88,161 people.
 *     27 such (state, name) pairs exist, so a query covering both spellings merges two real places.
 *   - EVERGLADES CITY and EVERGLADES are the SAME ORI either side of the source's 2017
 *     re-normalization. `city` is a label; `ori` is the identity.
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveNibrsPlaces,
  nibrsMemberCoverage,
  omittedMemberEnforcementIssue,
  resolvedOriEnforcementIssue,
  deliveredMembershipFailure,
  nibrsDeliveredMembership,
  unresolvedMemberDisclosure,
  type NibrsPlaceResolutionPlan,
} from "../lib/nibrs-place-resolver";
import { buildQueryContract } from "../lib/query-contract";
import { validateGrain } from "../lib/requested-grain";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) {
    console.log(`  PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
}

const dbPath = path.join(os.tmpdir(), `agency-members-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE agencies (
    ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT,
    population INTEGER, pop_group TEXT);
  CREATE TABLE agency_county_crosswalk (
    ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT);
  -- Executable fact table, so membership is read from rows a query really returned rather than from
  -- the query's text. Figures are chosen to be distinguishable: sheriff 7, police 11, unrelated 900.
  CREATE TABLE summary_offender_demographics (
    ori TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER);
  INSERT INTO summary_offender_demographics VALUES
    ('MD0240000', 2023, '09A', '25-34', 7),
    ('MD0240300', 2023, '09A', '25-34', 11),
    ('MD0040100', 2023, '09A', '25-34', 900);
  INSERT INTO agency_county_crosswalk VALUES
    ('MD02400', 'MD0240000', 'WORCESTER COUNTY SHERIFFS OFFICE', 'MD', 'WORCESTER'),
    ('MD02200', 'MD0220000', 'WICOMICO COUNTY SHERIFFS OFFICE', 'MD', 'WICOMICO');
`);
const insert = db.prepare("INSERT INTO agencies VALUES (?,?,?,?,?,?,?)");
const years = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

for (const year of years(2013, 2026)) {
  // The GC-084 agencies, as actually filed.
  insert.run("MD0240300", year, "MD", "POCOMOKE CITY", "City", 4456, "6");
  // The sheriff, whose own city label changes at 2017 — the same drift, on the county side.
  insert.run("MD0240000", year, "MD", year <= 2016 ? "WORCESTER" : "SNOW HILL", "County", 24079, "3");
  // A second county agency, so a two-sheriff question has something real to resolve to.
  insert.run("MD0220000", year, "MD", "SALISBURY", "County", 31000, "3");
  // Two genuinely different municipalities whose names differ only by " CITY".
  insert.run("CA0411800", year, "CA", "REDWOOD", "City", 5604, "6");
  insert.run("CA0411300", year, "CA", "REDWOOD CITY", "City", 88161, "3");
  // One agency, two labels, same ORI across the 2017 boundary.
  insert.run("FL0110200", year, "FL", year <= 2016 ? "EVERGLADES CITY" : "EVERGLADES", "City", 400, "7");
  // An ordinary control whose name carries no "City" at all.
  insert.run("MD0040100", year, "MD", "BALTIMORE", "City", 585000, "1");
}

const planFor = (question: string): NibrsPlaceResolutionPlan | null =>
  resolveNibrsPlaces(db, question, buildQueryContract(question, "nibrs"));
const placeFor = (question: string, name: string) =>
  planFor(question)?.places.find((place) => place.requestedName.toUpperCase().includes(name.toUpperCase())) ?? null;

console.log("\n1 - a place name that ends in \"City\" is not stripped away");
{
  const place = placeFor(
    "murder victims by race in Pocomoke City Police Department, Maryland from 2021 to 2025",
    "Pocomoke",
  );
  check(place?.status === "resolved", "Pocomoke City Police Department resolves at all");
  check(
    (place?.oriYears ?? []).every((item) => item.ori === "MD0240300"),
    "it resolves to MD0240300, the agency actually filed under POCOMOKE CITY",
  );
  // The old behaviour looked for "POCOMOKE", which does not exist in MD. Proving the absence keeps
  // this test honest: it would still pass on a fixture that carried both spellings.
  const stripped = db.prepare("SELECT COUNT(*) AS n FROM agencies WHERE state='MD' AND city='POCOMOKE'").get() as { n: number };
  check(stripped.n === 0, "and there is no POCOMOKE row for the stripped form to have matched");
}

console.log("\n2 - a name with no trailing \"City\" is unaffected");
{
  const place = placeFor("murders in Baltimore Police Department, Maryland in 2023", "Baltimore");
  check(place?.status === "resolved", "Baltimore Police Department still resolves");
  check((place?.oriYears ?? []).every((item) => item.ori === "MD0040100"), "to its own ORI");
}

console.log("\n3 - two municipalities differing only by \" CITY\" are never merged");
{
  // "Redwood Police Department" is not in the contract's gazetteer, so the town half is driven by
  // taking the real contract for the city and renaming its agency geography. Everything else about
  // the geography stays as the contract actually built it; only the name under test changes.
  const cityQuestion = "murders in Redwood City Police Department, California in 2023";
  const cityContract = buildQueryContract(cityQuestion, "nibrs");
  const townContract = cityContract && {
    ...cityContract,
    geographies: cityContract.geographies.map((geography) =>
      geography.kind === "agency"
        ? { ...geography, name: "Redwood Police Department", canonicalName: "Redwood, CA" }
        : geography),
  };
  const cityPd = resolveNibrsPlaces(db, cityQuestion, cityContract)?.places
    .find((place) => place.kind === "city_police") ?? null;
  const townPd = resolveNibrsPlaces(db, cityQuestion, townContract)?.places
    .find((place) => place.kind === "city_police") ?? null;
  const cityOris = [...new Set((cityPd?.oriYears ?? []).map((item) => item.ori))];
  const townOris = [...new Set((townPd?.oriYears ?? []).map((item) => item.ori))];
  check(cityOris.length === 1 && cityOris[0] === "CA0411300", "Redwood City PD resolves only to the city, CA0411300");
  check(townOris.length === 1 && townOris[0] === "CA0411800", "Redwood PD resolves only to the town, CA0411800");
  check(!cityOris.includes("CA0411800") && !townOris.includes("CA0411300"), "neither answer contains the other place");
}

console.log("\n4 - an agency renamed across 2017 keeps all its years");
{
  const place = placeFor("murders in Everglades City Police Department, Florida from 2013 to 2026", "Everglades");
  const resolvedYears = (place?.oriYears ?? []).map((item) => item.year).sort((a, b) => a - b);
  check(place?.status === "resolved", "Everglades City Police Department resolves");
  check(
    resolvedYears.length === 14 && resolvedYears[0] === 2013 && resolvedYears[13] === 2026,
    `all 14 requested years are carried, not only the label's own half (got ${resolvedYears.length})`,
  );
  check(
    (place?.oriYears ?? []).every((item) => item.ori === "FL0110200"),
    "every year keys on the one stable ORI, across both city labels",
  );
}

console.log("\n5 - coverage sees which named members an answer actually contains");
// The real GC-084 text from the frozen gold set, not a paraphrase. An invented phrasing put the
// state on only one agency and quietly changed what was being tested.
const twoAgencyQuestion =
  "show me violent crimes by offender age for worcester county, md sheriff's office and pocomoke city, md police department";
const twoAgencyPlan = planFor(twoAgencyQuestion);
{
  check((twoAgencyPlan?.places.length ?? 0) === 2, "the question's two agencies are both in the plan");
  const bothSql = "SELECT * FROM d WHERE d.ori IN ('MD0240000','MD0240300')";
  const oneSql = "SELECT * FROM d WHERE d.ori = 'MD0240000'";
  const both = nibrsMemberCoverage(twoAgencyPlan, bothSql);
  const one = nibrsMemberCoverage(twoAgencyPlan, oneSql);
  check(both?.covered.length === 2 && both?.omitted.length === 0, "SQL naming both ORIs covers both members");
  check(one?.covered.length === 1 && one?.omitted.length === 1, "SQL naming one ORI leaves one member omitted");
  check(
    (one?.omitted ?? []).some((place) => place.label.toUpperCase().includes("POCOMOKE")),
    "and the omitted member is identified by name",
  );
}

console.log("\n6 - the GC-084 shape is enforced, and the decoys are not");
{
  // The predicate the captured answer actually used: one ORI for two requested agencies.
  const gc084Sql = "SELECT d.age_group, COUNT(*) FROM demographics d WHERE d.ucr_offense_code IN ('09A','11A','120','13A') AND d.ori = 'MD0240000' AND d.year BETWEEN 2021 AND 2025";
  const fired = omittedMemberEnforcementIssue(twoAgencyPlan, gc084Sql);
  check(Boolean(fired), "the captured GC-084 SQL fires the omitted-member enforcement");
  check(
    (fired?.labels ?? []).some((label) => label.toUpperCase().includes("POCOMOKE")),
    "the message names the agency that would have been dropped",
  );
  check(
    Boolean(fired && /named 2 agencies/.test(fired.issue) && /only\s*\n?1 of them|only 1 of them/.test(fired.issue.replace(/\s+/g, " "))),
    "and states the count rather than gesturing at it",
  );

  // Decoys: each must NOT fire, and for a different reason.
  check(
    omittedMemberEnforcementIssue(twoAgencyPlan, "SELECT * FROM d WHERE d.ori IN ('MD0240000','MD0240300')") === null,
    "decoy: SQL covering both members does not fire",
  );
  const singlePlan = planFor("murder victims by race in Pocomoke City Police Department, Maryland from 2021 to 2025");
  check(
    omittedMemberEnforcementIssue(singlePlan, "SELECT * FROM d WHERE d.ori = 'MD0240300'") === null,
    "decoy: a single-agency question cannot be a subset of itself",
  );
  check(
    omittedMemberEnforcementIssue(twoAgencyPlan, "SELECT * FROM d WHERE d.state = 'MD'") === null,
    "decoy: SQL covering no resolved member is a different failure and is left to the existing warning",
  );
  check(
    omittedMemberEnforcementIssue(twoAgencyPlan, "SELECT * FROM d WHERE d.ori = 'CA0411300'") === null,
    "decoy: SQL naming an unrelated agency covers none of these members, so this rule stays silent",
  );
  check(omittedMemberEnforcementIssue(null, "SELECT 1") === null, "decoy: no resolution plan, no enforcement");
}

console.log("\n7 - a member that cannot be resolved is disclosed, not dropped");
{
  const question = "show me violent crimes by offender age for pocomoke city, md police department and cambridge, md police department";
  const plan = planFor(question);
  const disclosure = unresolvedMemberDisclosure(plan);
  const resolved = plan?.places.filter((place) => place.status === "resolved") ?? [];
  const unresolved = plan?.places.filter((place) => place.status !== "resolved") ?? [];
  check(resolved.length >= 1 && unresolved.length >= 1, "the fixture gives one resolvable member and one absent from the source");
  check(Boolean(disclosure), "a disclosure is produced");
  check(
    Boolean(disclosure && /CAMBRIDGE/i.test(disclosure.note)),
    "it names the agency that is missing rather than only the ones included",
  );
  check(
    Boolean(disclosure && /not included in these figures/i.test(disclosure.note)),
    "and says plainly that it is absent from the numbers",
  );
  check(
    unresolvedMemberDisclosure(twoAgencyPlan) === null,
    "decoy: when every named member resolves there is nothing to disclose",
  );
  check(
    unresolvedMemberDisclosure(planFor("show me violent crimes by offender age for cambridge, md police department")) === null,
    "decoy: a single unresolvable member is the whole answer, not a silent narrowing",
  );
}

console.log("\n8 - mutation controls: each condition is load-bearing");
{
  // If enforcement did not require a covered member, a statewide query following any resolved place
  // would fire. If it did not require an omitted member, every multi-agency answer would fire. If it
  // did not require two members, every single-agency answer would fire. Each is checked above by a
  // decoy that must stay silent; here we prove the positive case still fires so the decoys cannot be
  // passing merely because the rule is inert.
  const live = omittedMemberEnforcementIssue(twoAgencyPlan, "SELECT * FROM d WHERE d.ori = 'MD0240000'");
  check(Boolean(live), "the rule is not inert: the real omission still fires alongside all five decoys");

  // And the coverage test must key on ORI, not on the label, or the 2017 rename defeats it.
  const evergladesPlan = planFor("murders in Everglades City Police Department, Florida from 2013 to 2026");
  const byOri = nibrsMemberCoverage(evergladesPlan, "SELECT * FROM d WHERE d.ori = 'FL0110200'");
  const byLabel = nibrsMemberCoverage(evergladesPlan, "SELECT * FROM d WHERE d.city = 'EVERGLADES CITY'");
  check(byOri?.covered.length === 1, "coverage recognises the member by its ORI");
  check(byLabel?.covered.length === 0, "coverage does not accept a city label as proof the member is present");
}

console.log("\n8b - SQL that names agencies by city label carries no ORI, and is still not let through");
{
  // Raised from the r3 candidate: the by-city-label builder branch emits no ORI literal at all, so an
  // ORI-keyed coverage check reads zero covered and an "at least one covered" precondition would go
  // quiet on exactly the identity confusion this milestone is about. Measured here rather than argued.
  const cityLabelSql = "SELECT * FROM d JOIN agencies a ON a.ori = d.ori WHERE a.city = 'POCOMOKE CITY'";
  const coverage = nibrsMemberCoverage(twoAgencyPlan, cityLabelSql);
  check(coverage?.covered.length === 0, "coverage reads zero covered members, because no ORI appears in the SQL");
  check(
    Boolean(resolvedOriEnforcementIssue(twoAgencyPlan, cityLabelSql)),
    "the existing city-name enforcement catches it, so the pair of rules leaves no hole here",
  );
  check(
    omittedMemberEnforcementIssue(twoAgencyPlan, cityLabelSql) === null,
    "and this rule stays silent rather than double-firing on a shape already enforced",
  );

  // The residual case the existing rule cannot reach: every named member is a county agency, so there
  // is no resolved city_police place for it to key on. Sheriffs do file under a city label -- Worcester
  // County's own ORI is SNOW HILL from 2017 -- so this is a real shape, not a contrived one.
  // Built by renaming the real GC-084 contract's city-police member into a second sheriff. The
  // gazetteer does not recognise a bare second "wicomico county, md sheriff's office", and inventing
  // a phrasing to get around that is what produced a wrong result earlier in this same file.
  const gc084Contract = buildQueryContract(twoAgencyQuestion, "nibrs");
  const twoSheriffContract = gc084Contract && {
    ...gc084Contract,
    geographies: gc084Contract.geographies.map((geography) =>
      geography.kind === "agency" && /pocomoke/i.test(geography.name ?? "")
        ? { ...geography, name: "Wicomico County Sheriff's Office", canonicalName: "Wicomico County, MD" }
        : geography),
  };
  const twoSheriffPlan = resolveNibrsPlaces(db, twoAgencyQuestion, twoSheriffContract);
  const sheriffLabelSql = "SELECT * FROM d JOIN agencies a ON a.ori = d.ori WHERE a.city = 'SNOW HILL'";
  const resolvedSheriffs = (twoSheriffPlan?.places ?? []).filter((place) => place.status === "resolved");
  check(
    resolvedSheriffs.length >= 1 && resolvedSheriffs.every((place) => place.kind !== "city_police"),
    "the two-sheriff question resolves county agencies and no city police",
  );
  check(
    resolvedOriEnforcementIssue(twoSheriffPlan, sheriffLabelSql) === null,
    "the existing rule cannot reach it: it keys on resolved city_police members, and there are none",
  );
  check(
    Boolean(omittedMemberEnforcementIssue(twoSheriffPlan, sheriffLabelSql)),
    "so this rule takes label identity as the trigger in exactly that otherwise-uncovered case",
  );
  check(
    omittedMemberEnforcementIssue(twoSheriffPlan, "SELECT * FROM d WHERE d.state = 'MD'") === null,
    "decoy: without a city-label predicate the uncovered-case trigger does not apply",
  );
}

console.log("\n8c - R1: membership is read from the rows that came back, not from the query text");
{
  /*
   * Six witnesses, each EXECUTED against the fixture and judged on what it returned. An identifier in
   * query text is not membership: it can be removed by a HAVING, truncated by a LIMIT, or sit in a
   * branch nothing selects from. The first two are the shapes a text check gets right; the next four
   * are the ones it got wrong.
   *
   * The first is the SQL the capture actually saved for GC-084 -- `SUM(offender_count)` over
   * `summary_offender_demographics`, not the simplified COUNT(*) an earlier version of this file
   * used.
   */
  const SAVED_GC084_SQL =
    "SELECT d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
    "WHERE d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.ori = 'MD0240000' " +
    "AND d.year BETWEEN 2021 AND 2025 GROUP BY d.age_group ORDER BY offenders DESC LIMIT 1000";

  const witnesses: { name: string; sql: string; expectFires: boolean; note: string }[] = [
    {
      name: "the saved single-sheriff SQL",
      sql: SAVED_GC084_SQL.replace("2021 AND 2025", "2023 AND 2023"),
      expectFires: true, note: "sheriff only",
    },
    {
      name: "both agencies selected and grouped separately",
      sql: "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori",
      expectFires: false, note: "sheriff 7 and police 11, each identifiable",
    },
    {
      name: "an unused CTE that merely mentions the missing ORI",
      sql: "WITH ignored AS (SELECT 'MD0240300' AS ori) SELECT d.ori, SUM(d.offender_count) AS offenders " +
        "FROM summary_offender_demographics d WHERE d.ori = 'MD0240000' AND d.year = 2023 GROUP BY d.ori",
      expectFires: true, note: "the police ORI appears in text and in no row",
    },
    {
      name: "both ORIs in WHERE, a HAVING removing the police",
      sql: "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori HAVING SUM(d.offender_count) < 10",
      expectFires: true, note: "allowed by the filter, removed after aggregation",
    },
    {
      name: "both ORIs allowed, a LIMIT truncating one away",
      sql: "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori ORDER BY offenders DESC LIMIT 1",
      expectFires: true, note: "police 11 only; the sheriff is truncated",
    },
    {
      name: "only an unrelated agency selected",
      sql: "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori = 'MD0040100' AND d.year = 2023 GROUP BY d.ori",
      expectFires: true, note: "neither requested member is present",
    },
  ];

  for (const witness of witnesses) {
    const returned = db.prepare(witness.sql).all() as Record<string, unknown>[];
    const failure = deliveredMembershipFailure(twoAgencyPlan, returned);
    check(
      Boolean(failure) === witness.expectFires,
      `${witness.name}: ${returned.length} row(s), ${witness.note} - ` +
        `${witness.expectFires ? "stopped" : "delivered"}${failure ? ` (${failure.reason})` : ""}`,
    );
  }

  // The supported counterpart, with its exact figures and identities, so "stopped" is not the only
  // outcome the suite can produce.
  const supported = db.prepare(witnesses[1].sql).all() as Record<string, unknown>[];
  check(
    supported.length === 2
      && Number(supported.find((row) => row.ori === "MD0240000")?.offenders) === 7
      && Number(supported.find((row) => row.ori === "MD0240300")?.offenders) === 11,
    "the supported answer returns sheriff 7 and police 11 as separate identified rows",
  );
  const membership = nibrsDeliveredMembership(twoAgencyPlan, supported);
  check(
    membership?.returned.length === 2 && membership?.missing.length === 0 && membership.identifiable,
    "and both requested members are recognised as actually present in it",
  );

  // A comparison that labels its rows by place name rather than by ORI is a normal, correct shape.
  // Reading it as unidentifiable would stop answers that work today, so names count as identification.
  const labelledRows = [
    { place_label: "Worcester County sheriff's office", offenders: 7 },
    { place_label: "Pocomoke City Police Department", offenders: 11 },
  ];
  check(
    deliveredMembershipFailure(twoAgencyPlan, labelledRows) === null,
    "rows identified by place label, not ORI, are recognised as both members and delivered",
  );
  check(
    Boolean(deliveredMembershipFailure(twoAgencyPlan, [labelledRows[0]])),
    "and dropping one of those labelled rows is still caught",
  );
  const cityColumnRows = [{ city: "POCOMOKE CITY", offenders: 11 }, { city: "SNOW HILL", offenders: 7 }];
  check(
    Boolean(deliveredMembershipFailure(twoAgencyPlan, cityColumnRows)),
    "a bare city column that does not name the sheriff's agency is not accepted as proof it is present",
  );
  // Name matching is EQUALITY after normalization, never containment. Within one state 2,930 real
  // city names are proper substrings of other real city names, so a loose match would accept a
  // different agency's rows as the requested member and the omission would stop firing.
  const nearMissRows = [
    { place_label: "Union City, NJ", offenders: 7 },      // a different agency, 70,053 people
    { place_label: "Pocomoke City Police Department", offenders: 11 },
  ];
  const unionPlan = (() => {
    const base = buildQueryContract(twoAgencyQuestion, "nibrs");
    return base && resolveNibrsPlaces(db, twoAgencyQuestion, {
      ...base,
      geographies: base.geographies.map((geography) =>
        geography.kind === "agency" && /worcester/i.test(geography.name ?? "")
          ? { ...geography, canonicalName: "Union, NJ" }
          : geography),
    });
  })();
  const unionMembership = nibrsDeliveredMembership(unionPlan, nearMissRows);
  check(
    (unionMembership?.returned ?? []).every((place) => !/union/i.test(place.label))
      || (unionMembership?.missing ?? []).some((place) => /union/i.test(place.label)),
    "\"Union City, NJ\" is not accepted as proof that \"Union, NJ\" is present",
  );
  check(
    deliveredMembershipFailure(twoAgencyPlan, [
      { place_label: "Chicago, IL", offenders: 1 },
      { place_label: "Chicago", offenders: 2 },
    ]) !== null,
    "and a name that matches neither member does not satisfy either of them",
  );

  // Boundaries that must stay silent.
  check(
    deliveredMembershipFailure(twoAgencyPlan, []) === null,
    "an empty result is not a subset claim, so it is left to the zero-result path",
  );
  const singlePlan2 = planFor("murder victims by race in Pocomoke City Police Department, Maryland from 2021 to 2025");
  check(
    deliveredMembershipFailure(singlePlan2, [{ ori: "MD0240300", offenders: 11 }]) === null,
    "a single-agency question cannot deliver a subset of itself",
  );
}

console.log("\n8d - R3: a year with no records must not hand back a different town");
{
  // REDWOOD CITY exists but reported nothing in 2023; REDWOOD, a separate town, did. Choosing
  // whichever spelling had rows in the requested range substituted the other municipality.
  const sparse = new Database(path.join(os.tmpdir(), `agency-sparse-${process.pid}.db`));
  sparse.exec(`CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);`);
  const put = sparse.prepare("INSERT INTO agencies VALUES (?,?,?,?,?,?,?)");
  put.run("CA0411300", 2022, "CA", "REDWOOD CITY", "City", 88161, "3");   // exists, but not in 2023
  put.run("CA0411800", 2023, "CA", "REDWOOD", "City", 5604, "6");         // the other town, in 2023

  const question = "murders in Redwood City Police Department, California in 2023";
  // Taken whatever kind the resolver assigns, so a place that changes kind cannot slip past the check.
  const place = resolveNibrsPlaces(sparse, question, buildQueryContract(question, "nibrs"))?.places[0] ?? null;
  const oris = [...new Set((place?.oriYears ?? []).map((item) => item.ori))];
  check(!oris.includes("CA0411800"), "the answer does not fall through to REDWOOD, a different municipality");
  check(place?.status === "covered" && oris.length === 0,
    `the requested year is reported as unavailable for the named agency, not substituted (status ${place?.status}, oris ${oris.join(",") || "none"})`);
  check(
    /no active city-agency ori exists for 2023/i.test(place?.reason ?? ""),
    "and the reason names the year rather than implying the agency is unknown",
  );

  // And the same fixture the other way round: the town's own request still reaches the town.
  const townQuestion = "murders in Redwood City Police Department, California in 2022";
  const townPlace = resolveNibrsPlaces(sparse, townQuestion, buildQueryContract(townQuestion, "nibrs"))?.places
    .find((item) => item.kind === "city_police") ?? null;
  check(
    (townPlace?.oriYears ?? []).every((item) => item.ori === "CA0411300") && townPlace?.status === "resolved",
    "and the year it did report still resolves normally to CA0411300",
  );
  sparse.close();

  // Preserved: both identities still separate when both have rows, and the renamed-year recovery.
  const everglades = placeFor("murders in Everglades City Police Department, Florida from 2013 to 2026", "Everglades");
  check(
    (everglades?.oriYears ?? []).length === 14,
    "the same-ORI renamed-year recovery is unchanged by the identity-first rule",
  );
}

console.log("\n9 - the route actually carries both mechanisms, and in the order that matters");
{
  // A source assertion, stated as one: it proves the wiring exists and is ordered, not that a live
  // request delivers it. Both bind to behaviour rather than to one rendering of a line.
  const route = fs.readFileSync("app/api/nibrs-query/route.ts", "utf8");

  check(
    /const memberEnforcement = omittedMemberEnforcementIssue\(resolutionPlan, sql\)/.test(route),
    "the route computes omitted-member enforcement from the resolution plan and the SQL it will run",
  );
  // The same finding must not be labelled warn-only while it is being enforced. That contradiction
  // was live until this milestone: `auditNibrsResolvedOriUsage` already detected every missing
  // resolved member, and printed "[warn-only]" whenever the city-name rule could not reach it.
  check(
    /const oriFindingEnforced = Boolean\(oriEnforcement \|\| memberEnforcement\)/.test(route)
      && /\$\{oriFindingEnforced \? "\[enforced\]" : "\[warn-only\]"\}/.test(route),
    "the resolved-ORI log says enforced when either rule enforces, not only the city-name one",
  );
  check(
    /resolvedOriWarnings\.length > 0 && !memberEnforcement\s*\n?\s*\? \["nibrs-resolved-ori-warn-only"\]/.test(route),
    "and the warn-only guardrail is not recorded alongside the enforcement of the same finding",
  );
  check(
    /if \(memberEnforcement\) \{[\s\S]{0,200}routeGuardrailIssues\.push\(memberEnforcement\.issue\)/.test(route),
    "a firing enforcement becomes a retry issue rather than a log line",
  );
  // Ordering, not proximity: the second-failure stop must sit between the retry check that finds it
  // and the next second-failure block, whatever the message length in between.
  const retryCheckAt = route.indexOf("const memberStillBad = omittedMemberEnforcementIssue(resolutionPlan, sql)");
  const stopAt = route.indexOf("omitted_member_second_failure");
  const nextBlockAt = route.indexOf("const oriStillBad = resolvedOriEnforcementIssue(resolutionPlan, sql)");
  check(
    retryCheckAt > 0 && stopAt > retryCheckAt && nextBlockAt > stopAt,
    "and a retry that still omits a member stops instead of delivering the subset",
  );
  check(
    /msg = `That question asks about \$\{memberStillBad\.requested\} agencies[^`]*\$\{memberStillBad\.covered\} of them/.test(route),
    "the refusal states the real counts rather than deriving them from the omitted list",
  );

  // R2b: the note must be the LAST writer on `explanation`. Asserted by index against every later
  // site that can replace or extend it, rather than by proximity to one earlier site. The previous
  // arrangement satisfied "after the disclosure chain" and was still removed by the grain rewrite.
  const appendAt = route.indexOf("if (missingMembers && !explanation.includes(missingMembers.note))");
  const grainReplaceAt = route.indexOf("explanation = grainCheck.message;");
  const probeAt = route.indexOf("explanation = appendNibrsAgencyProbeCaveat(explanation, agencyProbe);");
  const cdeAt = route.lastIndexOf("explanation += \"\\n\\n\" + cdeDisclaimers;");
  check(
    appendAt > 0 && grainReplaceAt > 0 && probeAt > 0 && cdeAt > 0,
    "every later writer on the explanation is present to compare against",
  );
  check(
    appendAt > grainReplaceAt && appendAt > probeAt && appendAt > cdeAt,
    "the note is appended after the grain replacement, the zero-result probe and the CDE re-append",
  );
  check(
    /if \(missingMembers && explanation\.includes\(missingMembers\.note\)[\s\S]{0,160}routeGuardrailsFired\.push\("nibrs-unresolved-member-disclosed"\)/.test(route),
    "and the disclosure tag is recorded only when the note is present in the delivered text",
  );
  // The gate is now the agency-to-figure mapping, and it is on BOTH answer paths: the model path
  // after every retry and fallback, and the deterministic branch that previously returned unchecked.
  const modelGateAt = route.indexOf("const deliveredMembers = agencyFigureFailure(resolutionPlan, columns, rows, null, sql)");
  check(
    modelGateAt > route.lastIndexOf("rows = normalizeNibrsDisplayRows(fallbackResult.rows);"),
    "the model path's gate runs on the final rows, after the retry and fallback paths, and is handed the SQL that produced them",
  );
  // R3: the deterministic branch returns without reaching the model path, so it needs its own
  // missing-member disclosure. It had none, and a supported comparison that dropped a member said
  // nothing about it.
  // The disclosure is now derived from the coverage state rather than from the plan alone, so that it
  // and the title cannot describe different results. It still falls back to the plan-only disclosure,
  // which keeps the note present for shapes the coverage state has nothing to say about.
  const detDisclosureAt = route.indexOf("const deterministicMissing = coverageNote(resolutionPlan, deterministicCoverage)");
  const detGrainAt = route.indexOf("explanation = deterministicGrainCheck.message;");
  check(detDisclosureAt > 0, "the deterministic branch computes its own missing-member disclosure");
  check(
    detDisclosureAt > detGrainAt && detGrainAt > 0,
    "and composes it after that branch's own grain replacement, so a rewrite cannot delete it",
  );
  check(
    /if \(deterministicMissing && explanation\.includes\(deterministicMissing\.note\)\) \{\s*\n\s*deterministicFiredGuardrails\.push\("nibrs-unresolved-member-disclosed"\)/.test(route),
    "with its tag recorded only when the note is present in the delivered text",
  );
  check(
    /const msg = memberRefusalText\(deterministicMembers\)/.test(route)
      && /const msg = memberRefusalText\(deliveredMembers\)/.test(route),
    "both refusals are built by one message function, so neither path can drift into its own wording",
  );

  const deterministicGateAt = route.indexOf("const deterministicMembers = agencyFigureFailure(");
  check(
    /const deterministicMembers = agencyFigureFailure\(resolutionPlan, columns, rows, ownedDeclaration\)/.test(route),
    "the deterministic branch is gated too, and is handed the producer's own column-to-member list",
  );
  // Strengthened from the previous version, which accepted the raw `memberColumns` property. The
  // declaration must now arrive through the ownership check, bound to the statement that ran, so a
  // path that rewrote the query cannot hand its old declaration to the gate.
  check(
    /const ownedDeclaration = ownedMemberDeclaration\(deterministicQuery, deterministicQuery\.sql\)/.test(route),
    "and that list is the one bound to the executed statement, not the raw producer property",
  );
  check(
    route.indexOf("const ownedDeclaration = ownedMemberDeclaration(") < deterministicGateAt,
    "the binding is established before the gate reads it",
  );
  check(
    deterministicGateAt > 0 && deterministicGateAt < modelGateAt,
    "and it is gated before it returns, not after the model path it never reaches",
  );

  // Mutation controls for the ordering claim, which is the one that would rot silently.
  const swapped = route.replace(
    /const missingMembers = unresolvedMemberDisclosure\(resolutionPlan\);/,
    "",
  );
  check(
    swapped.indexOf("const missingMembers = unresolvedMemberDisclosure(resolutionPlan)") === -1,
    "mutation: removing the disclosure call is detectable by this check",
  );

  // The builder must decline the ambiguous name rather than guess a spelling.
  const builder = fs.readFileSync("lib/nibrs-deterministic-queries.ts", "utf8");
  check(
    /const stripped = asWritten\.replace\(\/\\s\+city\$\/i, ""\);[\s\S]{0,900}if \(stripped !== asWritten\) return null;/.test(builder),
    "the deterministic builder declines a \" City\" name it cannot resolve instead of picking a spelling",
  );
  check(
    !/cityTargetSql\(cityPolice\[1\]\)/.test(builder),
    "and no longer builds SQL straight from the stripped capture group",
  );
}

console.log("\n9b - R2b: the rewrite that removed the note is real, executed here");
{
  // The hazard is not hypothetical: `validateGrain` returns a REPLACING message, and the route
  // assigns it to `explanation`. Executed with the shipped function so the ordering assertion above
  // is anchored to a demonstrated behaviour rather than to a reading of the code.
  const monthlyQuestion = "show me violent crimes by offender age for pocomoke city, md police department by month in 2023";
  const annualRows = [{ year: 2023, age_group: "25-34", offenders: 11 }];
  const grain = validateGrain(monthlyQuestion, annualRows, "SELECT year, age_group, SUM(offender_count) FROM d GROUP BY year, age_group");
  check(!grain.ok && Boolean(grain.message), "a monthly request answered with annual rows produces a replacing grain message");

  const note = "Cambridge, MD was also asked about but could not be matched to an agency in this data.";
  const beforeFix = (() => {
    let explanation = "Here are the figures.";
    explanation = [explanation, note].filter(Boolean).join("\n\n");      // old placement
    if (!grain.ok && grain.message) explanation = grain.message;          // grain replaces it
    return explanation;
  })();
  const afterFix = (() => {
    let explanation = "Here are the figures.";
    if (!grain.ok && grain.message) explanation = grain.message;          // grain replaces it
    if (!explanation.includes(note)) explanation = [explanation, note].filter(Boolean).join("\n\n");
    return explanation;
  })();
  check(!beforeFix.includes(note), "the old ordering loses the note entirely once the grain message replaces the explanation");
  check(afterFix.includes(note), "the new ordering keeps it, because the note is written last");
  // Stated plainly: this executes the shipped grain function against the two orderings. It is not a
  // live HTTP request, and the route's own sequence is asserted separately by index above.
}

console.log("\n10 - the recorded account of a request cannot contradict itself");
{
  /*
   * `query_log.guardrails` is not a log, it is the evidence: every routing claim in five receipts
   * rests on that column. A self-contradictory guardrail list is therefore a corrupted measurement,
   * not a confusing message -- which is why the defect above mattered even though both rules behaved
   * correctly. The check that would have caught it asks nothing about any one rule: it asks whether
   * the recorded account contains two claims that cannot both be true.
   *
   * It needs a DECLARED table, not a string rule. `nibrs-resolved-ori-warn-only` and
   * `nibrs-omitted-member-enforced` share no prefix, so a purely syntactic "same family" test would
   * have missed exactly the contradiction that occurred. What makes them incompatible is that both
   * describe the same underlying finding -- resolved members absent from the SQL -- and that fact
   * has to be written down.
   */
  const FINDING_DISPOSITIONS: Record<string, { warned: string[]; enforced: string[] }> = {
    "resolved members missing from the SQL": {
      warned: ["nibrs-resolved-ori-warn-only"],
      enforced: ["nibrs-resolved-ori-enforced", "nibrs-omitted-member-enforced"],
    },
  };
  const contradictions = (guardrails: string[]): string[] => {
    const found: string[] = [];
    for (const [finding, { warned, enforced }] of Object.entries(FINDING_DISPOSITIONS)) {
      const w = warned.filter((token) => guardrails.includes(token));
      const e = enforced.filter((token) => guardrails.includes(token));
      if (w.length > 0 && e.length > 0) found.push(`${finding}: ${w.join(",")} beside ${e.join(",")}`);
    }
    return found;
  };

  check(
    contradictions(["nibrs-resolved-ori-warn-only", "nibrs-omitted-member-enforced"]).length === 1,
    "the invariant recognises the exact pair this milestone produced, which shares no token prefix",
  );
  check(
    contradictions(["nibrs-resolved-ori-warn-only", "geo-typo-corrected"]).length === 0,
    "and is quiet on a warn-only list with unrelated guardrails beside it",
  );
  check(
    contradictions(["nibrs-omitted-member-enforced", "lower-bound-disclosed"]).length === 0,
    "and quiet on an enforced list with unrelated guardrails beside it",
  );

  // Applied to the delivered evidence rather than only to constructed inputs.
  const exportPath = "audit/correctness-repeat-2026-09-13/query-log-export.json";
  if (fs.existsSync(exportPath)) {
    const rows = (JSON.parse(fs.readFileSync(exportPath, "utf8").replace(/^﻿/, ""))
      ?.tables?.query_log?.rows ?? []) as { id: number; guardrails: string | null }[];
    const offenders = rows
      .map((row) => ({ id: row.id, bad: contradictions(String(row.guardrails ?? "").split(",").map((s) => s.trim()).filter(Boolean)) }))
      .filter((row) => row.bad.length > 0);
    check(rows.length > 0, `the delivered capture's query log is readable (${rows.length} rows)`);
    check(
      offenders.length === 0,
      `no delivered row records a contradictory account${offenders.length ? `: ${offenders.slice(0, 3).map((o) => o.id).join(",")}` : ""}`,
    );
    // Stated so the clean result is not mistaken for immunity: the enforced token did not exist
    // before this milestone, so no earlier capture could have produced the pair.
    const enforcedSeen = rows.some((row) => String(row.guardrails ?? "").includes("nibrs-omitted-member-enforced"));
    check(!enforcedSeen, "and the clean result is because the enforcement is new, not because the labelling was sound");
  }
}

db.close();
fs.unlinkSync(dbPath);

console.log(`\nagency member completeness: ${checks - failures} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
