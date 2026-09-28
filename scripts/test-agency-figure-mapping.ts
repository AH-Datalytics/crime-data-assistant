/*
 * Which agency does each figure in an answer belong to?
 *
 * Every witness here is EXECUTED. The supported comparison is built by the real builder and run on a
 * fixture, and its figures are checked against values computed independently in this file rather than
 * against literals copied out of the same object. The unsupported shapes are real SQL executed against
 * the same fixture and judged on what came back.
 *
 * Three things the mapping must never do, each from a witness that defeated an earlier version:
 *   - credit a member because its name appears: SQL filtering one ORI can project another agency's
 *     name as a literal, and the figures are still the first agency's.
 *   - credit a member because a column heading looks like its label: the heading is written by
 *     whoever wrote the query.
 *   - credit a member through a display label: two agencies can share one label ("Mobile"), and the
 *     producer's key is the only part of the binding a label collision cannot reach.
 */
import Database from "better-sqlite3";
import * as os from "os";
import * as path from "path";
import {
  resolveNibrsPlaces,
  unresolvedMemberDisclosure,
  type NibrsPlaceResolutionPlan,
} from "../lib/nibrs-place-resolver";
import { buildQueryContract } from "../lib/query-contract";
import { buildNibrsStructuredLocalTrendQuery } from "../lib/nibrs-deterministic-queries";
import { mapAgencyFigures, agencyFigureFailure, memberRefusalText, AGENCY_IDENTITY_COLUMNS } from "../lib/nibrs-member-figures";
import { sanitizeUserFacingNarrative } from "../lib/scaffold-helpers";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const db = new Database(path.join(os.tmpdir(), `agency-figures-${process.pid}-${Math.random().toString(36).slice(2)}.db`));
db.exec(`
  CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);
  CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT);
  CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);
  CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);
  CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);
  CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);
  CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);
  CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);
  CREATE TABLE summary_offender_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER);
  INSERT INTO agency_county_crosswalk VALUES
    ('MD02400','MD0240000','WORCESTER COUNTY SHERIFFS OFFICE','MD','WORCESTER'),
    ('NM00100','NM0010000','BERNALILLO COUNTY SHERIFFS OFFICE','NM','BERNALILLO');
`);

const agency = db.prepare("INSERT INTO agencies VALUES (?,?,?,?,?,?,?)");
const complete = db.prepare("INSERT INTO nibrs_agency_completeness VALUES (?,?,12)");
const victims = db.prepare("INSERT INTO summary_victim_city_monthly VALUES (?,?,?,?,?)");

/* The comparison members, and the murder counts this file will verify the answer against. */
const ABQ = "NM0010100";
const BERN = "NM0010000";
const MURDERS: Record<string, Record<number, number>> = {
  [ABQ]: { 2020: 76, 2021: 84, 2022: 62 },
  [BERN]: { 2020: 8, 2021: 11, 2022: 5 },
};
for (let year = 2019; year <= 2024; year += 1) {
  agency.run(ABQ, year, "NM", "ALBUQUERQUE", "City", 560000, "1");
  agency.run(BERN, year, "NM", "BERNALILLO", "County", 120000, "2");
  complete.run(ABQ, year);
  complete.run(BERN, year);
  // The GC-084 agencies, and an unrelated control.
  agency.run("MD0240300", year, "MD", "POCOMOKE CITY", "City", 4456, "6");
  agency.run("MD0240000", year, "MD", year <= 2016 ? "WORCESTER" : "SNOW HILL", "County", 24079, "3");
  agency.run("MD0040100", year, "MD", "BALTIMORE", "City", 585000, "1");
  // Two agencies in different states sharing the name "Springfield".
  agency.run("IL1080000", year, "IL", "SPRINGFIELD", "City", 114000, "3");
  agency.run("MO0770000", year, "MO", "SPRINGFIELD", "City", 169000, "2");
}
// One month per year carrying the whole count keeps the expected totals easy to state and to check.
for (const [ori, byYear] of Object.entries(MURDERS)) {
  for (const [year, count] of Object.entries(byYear)) victims.run(ori, Number(year), 1, "09A", count);
}
const offenders = db.prepare("INSERT INTO summary_offender_demographics VALUES (?,?,?,?,?)");
offenders.run("MD0240000", 2023, "09A", "25-34", 7);
offenders.run("MD0240300", 2023, "09A", "25-34", 11);
offenders.run("MD0040100", 2023, "09A", "25-34", 900);

const planFor = (question: string): NibrsPlaceResolutionPlan | null =>
  resolveNibrsPlaces(db, question, buildQueryContract(question, "nibrs"));

console.log("\n1 - the supported comparison, built and executed, with figures verified independently");
const COMPARISON_QUESTION =
  "compare murders in albuquerque police department and bernalillo county sheriff by year since 2020";
const comparisonPlan = planFor(COMPARISON_QUESTION);
const built = buildNibrsStructuredLocalTrendQuery(COMPARISON_QUESTION, comparisonPlan);
{
  check(Boolean(built), "the real builder produces a comparison query for this question");
  const rows = built ? (db.prepare(built.sql).all() as Record<string, unknown>[]) : [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  check(rows.length > 0, `executing it returns rows (${rows.length})`);

  // Expected values are computed here from the fixture inputs, not read off the result.
  const expected = (ori: string, year: number) => MURDERS[ori][year] ?? 0;
  const abqColumn = built?.memberColumns?.find((entry) => entry.contractIndex === 0)?.column ?? "";
  const bernColumn = built?.memberColumns?.find((entry) => entry.contractIndex === 1)?.column ?? "";
  const row2021 = rows.find((row) => Number(row.year) === 2021) ?? {};
  check(
    Number(row2021[abqColumn]) === expected(ABQ, 2021) && Number(row2021[bernColumn]) === expected(BERN, 2021),
    `2021 returns Albuquerque ${expected(ABQ, 2021)} and Bernalillo ${expected(BERN, 2021)}, matching the fixture inputs`,
  );

  const mapping = mapAgencyFigures(comparisonPlan, columns, rows, built?.memberColumns);
  check(mapping?.shape === "producer-declared", `identity comes from the producer's declaration (${mapping?.shape})`);
  check((mapping?.conflicts ?? []).length === 0, "with no conflicts");
  const owned = new Map((mapping?.members ?? []).map((entry) => [entry.member.contractIndex, entry.columns]));
  check(
    owned.get(0)?.join() === abqColumn && owned.get(1)?.join() === bernColumn,
    "each member owns exactly its own column, and not the other's",
  );
  check(
    agencyFigureFailure(comparisonPlan, columns, rows, built?.memberColumns) === null,
    "so the supported comparison is delivered, not stopped",
  );
}

console.log("\n2 - the producer's KEY carries the binding; the display label cannot");
{
  /*
   * Two members whose labels are identical. Every label-based reading gives each of them both
   * columns; only the contract index separates them. Values 4 and 9 are distinct so a swap is
   * visible, and `place_2`'s column is the one carrying 9.
   */
  const tied = {
    places: [
      { ...(comparisonPlan!.places[0]), contractIndex: 0, label: "Mobile", requestedName: "Mobile, AL",
        status: "resolved" as const, oriYears: [{ year: 2023, ori: "AL0021300", population: 1000 }] },
      { ...(comparisonPlan!.places[1]), contractIndex: 1, label: "Mobile", requestedName: "MOBILE, AL",
        status: "resolved" as const, oriYears: [{ year: 2023, ori: "AL0020000", population: 2000 }] },
    ],
  } as NibrsPlaceResolutionPlan;
  const columns = ["year", "mobile_murders", "mobile_murders_2"];
  const rows = [{ year: 2023, mobile_murders: 4, mobile_murders_2: 9 }];
  const declared = [
    { column: "mobile_murders", placeKey: "place_1", contractIndex: 0, placeLabel: "Mobile" },
    { column: "mobile_murders_2", placeKey: "place_2", contractIndex: 1, placeLabel: "Mobile" },
  ];

  const mapping = mapAgencyFigures(tied, columns, rows, declared);
  const first = (mapping?.members ?? []).find((entry) => entry.member.contractIndex === 0);
  const second = (mapping?.members ?? []).find((entry) => entry.member.contractIndex === 1);
  check(first?.columns.join() === "mobile_murders", `member 0 owns only mobile_murders (${first?.columns.join() || "none"})`);
  check(second?.columns.join() === "mobile_murders_2", `member 1 owns only mobile_murders_2 (${second?.columns.join() || "none"})`);
  check(
    Number(rows[0][first!.columns[0] as "mobile_murders"]) === 4
      && Number(rows[0][second!.columns[0] as "mobile_murders_2"]) === 9,
    "and the figures follow: member 0 has 4, member 1 has 9",
  );

  // Rejections. Each must be reported, not silently absorbed.
  const unknownKey = mapAgencyFigures(tied, columns, rows,
    [{ column: "mobile_murders", placeKey: "place_999", contractIndex: 998, placeLabel: "Mobile" }]);
  check(
    (unknownKey?.conflicts ?? []).some((text) => /never requested/.test(text)),
    "a declaration naming a member that does not exist is rejected, not accepted on its label",
  );
  // The counterpart, and the distinction the previous version could not draw: index 1 IS a member the
  // user asked for -- the resolver just could not resolve it. That is an unresolved member, disclosed
  // separately, not evidence that the members it DID resolve disagree with each other. Reporting it as
  // a conflict stopped an internally consistent supported subset with "the identifying details don't
  // agree", which asserted a disagreement that never occurred.
  const unresolvedMember = {
    ...tied,
    places: tied.places.map((place, index) =>
      index === 1 ? { ...place, status: "not_in_source" as const, oriYears: [], oriRanges: [] } : place),
  } as NibrsPlaceResolutionPlan;
  const withUnresolved = mapAgencyFigures(unresolvedMember, columns, rows, declared);
  check(
    (withUnresolved?.conflicts ?? []).length === 0,
    `a member the resolver could not resolve is not reported as conflicting evidence (${(withUnresolved?.conflicts ?? []).join("; ") || "none"})`,
  );
  check(
    (withUnresolved?.members ?? []).find((entry) => entry.member.contractIndex === 0)?.columns.join() === "mobile_murders",
    "and the member that did resolve keeps its own figures",
  );
  const unresolvedFailure = agencyFigureFailure(unresolvedMember, columns, rows, declared);
  check(
    unresolvedFailure === null || !/don't agree|do not agree/.test(memberRefusalText(unresolvedFailure)),
    "so delivery does not stop by asserting the identifying details disagree",
  );
  const absentColumn = mapAgencyFigures(tied, ["year", "mobile_murders"], rows, declared);
  check(
    (absentColumn?.conflicts ?? []).some((text) => /result does not contain/.test(text)),
    "a declared column the result does not contain is rejected",
  );
  const doubleClaim = mapAgencyFigures(tied, columns, rows, [
    { column: "mobile_murders", placeKey: "place_1", contractIndex: 0, placeLabel: "Mobile" },
    { column: "mobile_murders", placeKey: "place_2", contractIndex: 1, placeLabel: "Mobile" },
  ]);
  check(
    (doubleClaim?.conflicts ?? []).some((text) => /more than one member/.test(text)),
    "one column claimed by two members is rejected",
  );
  check(
    Boolean(agencyFigureFailure(tied, columns, rows, [declared[0]])),
    "and losing a member's binding altogether stops delivery",
  );
}

console.log("\n3 - only source-backed identity counts: a projected name is not evidence");
const GC084_QUESTION =
  "show me violent crimes by offender age for worcester county, md sheriff's office and pocomoke city, md police department";
const gc084Plan = planFor(GC084_QUESTION);
{
  check((gc084Plan?.places.length ?? 0) === 2, "the two named agencies both resolve");

  // The witness: filter one ORI, project the OTHER agency's identifier as a literal.
  const spoofed = db.prepare(
    "SELECT d.ori, 'MD0240300' AS agency_name, d.age_group, SUM(d.offender_count) AS offenders " +
    "FROM summary_offender_demographics d WHERE d.ori = 'MD0240000' AND d.year = 2023 " +
    "GROUP BY d.ori, d.age_group",
  ).all() as Record<string, unknown>[];
  check(
    spoofed.length === 1 && Number(spoofed[0].offenders) === 7,
    `the spoofed query returns only the sheriff's 7 (${spoofed.map((r) => r.offenders).join()})`,
  );
  const spoofFailure = agencyFigureFailure(gc084Plan, Object.keys(spoofed[0]), spoofed);
  check(Boolean(spoofFailure), "and it is stopped, not credited to both agencies");
  check(
    Boolean(spoofFailure) && spoofFailure!.missing.some((label) => /pocomoke/i.test(label)),
    "with Pocomoke named as the agency whose figures are absent",
  );

  // Same shape, honest: both ORIs present, no contradicting name.
  const honest = db.prepare(
    "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
    "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori",
  ).all() as Record<string, unknown>[];
  check(
    honest.length === 2 && Number(honest.find((r) => r.ori === "MD0240300")?.offenders) === 11,
    "the honest two-agency query returns both, with Pocomoke at 11",
  );
  check(agencyFigureFailure(gc084Plan, Object.keys(honest[0]), honest) === null, "and is delivered");

  // An unrelated agency's rows satisfy neither member.
  const unrelated = db.prepare(
    "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
    "WHERE d.ori = 'MD0040100' AND d.year = 2023 GROUP BY d.ori",
  ).all() as Record<string, unknown>[];
  const unrelatedFailure = agencyFigureFailure(gc084Plan, Object.keys(unrelated[0]), unrelated);
  check(Boolean(unrelatedFailure), "an unrelated agency's rows do not satisfy either member");
  check(
    Boolean(unrelatedFailure) && unrelatedFailure!.missing.length === 2,
    "and both requested agencies are reported missing, not one assumed present",
  );
}

console.log("\n4 - an ORI must agree with the member's state");
{
  // Two real Springfields. A Missouri row must not satisfy an Illinois member.
  const illinois = {
    places: [
      { ...(gc084Plan!.places[0]), contractIndex: 0, label: "Springfield, IL", requestedName: "Springfield, IL",
        state: "IL", status: "resolved" as const, oriYears: [{ year: 2023, ori: "IL1080000", population: 114000 }] },
      { ...(gc084Plan!.places[1]), contractIndex: 1, label: "Pocomoke City Police Department",
        state: "MD", status: "resolved" as const, oriYears: [{ year: 2023, ori: "MD0240300", population: 4456 }] },
    ],
  } as NibrsPlaceResolutionPlan;
  const missouriRow = [{ ori: "MO0770000", agency_name: "Springfield", offenders: 40 },
                       { ori: "MD0240300", offenders: 11 }];
  const failure = agencyFigureFailure(illinois, ["ori", "agency_name", "offenders"], missouriRow);
  check(Boolean(failure), "a Missouri Springfield row does not satisfy the Illinois member");
  check(
    Boolean(failure) && failure!.missing.some((label) => /springfield/i.test(label)),
    "and the Illinois member is the one reported missing",
  );
}

console.log("\n5 - a name column that contradicts the ORI credits neither");
{
  const rows = [{ ori: "MD0240000", place_label: "Pocomoke City Police Department", offenders: 7 },
                { ori: "MD0240300", offenders: 11 }];
  const mapping = mapAgencyFigures(gc084Plan, ["ori", "place_label", "offenders"], rows);
  check(
    (mapping?.conflicts ?? []).some((text) => /by ORI and/.test(text)),
    "the contradiction is reported rather than resolved in someone's favour",
  );
  const sheriff = (mapping?.members ?? []).find((entry) => /worcester/i.test(entry.member.label));
  check(sheriff?.rowCount === 0, "and the contradicted row is credited to no one");
  check(Boolean(agencyFigureFailure(gc084Plan, ["ori", "place_label", "offenders"], rows)),
    "so the answer is stopped");
}

console.log("\n6 - a result with no source-backed identity is unestablishable, and invents nothing");
{
  // The real GC-084 shape: eight rows of figures with nothing saying whose they are. Values are the
  // eight actually captured on 2026-09-13.
  const columns = ["age_group", "offenders"];
  const rows = [26, 24, 19, 15, 13, 12, 10, 2].map((offenders, index) => ({ age_group: `band-${index}`, offenders }));
  const mapping = mapAgencyFigures(gc084Plan, columns, rows);
  check(mapping?.establishable === false && mapping?.shape === "none",
    "the mapping reports it cannot say whose figures these are");
  const failure = agencyFigureFailure(gc084Plan, columns, rows);
  check(Boolean(failure) && failure!.establishable === false, "delivery is refused");
  check(
    Boolean(failure) && /does not say which/.test(failure!.reason),
    "and the reason says the answer is unidentifiable, not that an agency is absent",
  );
  check(
    Boolean(failure) && !/\b0\b|zero/i.test(failure!.reason),
    "no zero is invented for the agency that is not there",
  );

  // A model-authored pivot has no producer list, so its headings grant nothing.
  const modelPivot = agencyFigureFailure(gc084Plan,
    ["year", "worcester_county_sheriffs_office_murders", "pocomoke_city_police_department_murders"],
    [{ year: 2023, worcester_county_sheriffs_office_murders: 7, pocomoke_city_police_department_murders: 11 }]);
  check(Boolean(modelPivot) && modelPivot!.establishable === false,
    "a model-written column heading does not establish membership on its own");
}

console.log("\n7 - unavailable evidence is not a zero");
{
  const rows = [{ ori: "MD0240000", offenders: null }, { ori: "MD0240300", offenders: null }];
  const mapping = mapAgencyFigures(gc084Plan, ["ori", "offenders"], rows);
  check(
    (mapping?.members ?? []).every((entry) => entry.evidence === "identity-column" && entry.allValuesMissing),
    "rows present with null measures are recorded as present-with-nothing-to-report",
  );
  check(agencyFigureFailure(gc084Plan, ["ori", "offenders"], rows) === null,
    "and that is not a membership failure: both agencies are in the answer");
}

console.log("\n8 - boundaries");
{
  const single = planFor("show me violent crimes by offender age for pocomoke city, md police department");
  check(agencyFigureFailure(single, ["ori", "offenders"], [{ ori: "MD0240300", offenders: 11 }]) === null,
    "a single-agency question cannot deliver a subset of itself");
  check(agencyFigureFailure(gc084Plan, ["ori", "offenders"], []) === null,
    "an empty result makes no completeness claim");
  check(mapAgencyFigures(null, ["ori"], []) === null, "no plan, no mapping");
  check(
    AGENCY_IDENTITY_COLUMNS.includes("ori") && !AGENCY_IDENTITY_COLUMNS.includes("age_group" as never),
    "identity columns are a declared list, so an ordinary measure column cannot become identity",
  );
}

console.log("\n9 - mutation controls: each rule is load-bearing");
{
  const rows = [{ ori: "MD0240000", offenders: 7 }];
  const columns = ["ori", "offenders"];

  // Ignoring the producer key and falling back to labels: the tied pair would each take both columns.
  const tied = {
    places: [
      { ...(gc084Plan!.places[0]), contractIndex: 0, label: "Mobile", status: "resolved" as const,
        oriYears: [{ year: 2023, ori: "AL0021300", population: 1 }] },
      { ...(gc084Plan!.places[1]), contractIndex: 1, label: "Mobile", status: "resolved" as const,
        oriYears: [{ year: 2023, ori: "AL0020000", population: 2 }] },
    ],
  } as NibrsPlaceResolutionPlan;
  const byLabelWouldTie = ["mobile_murders", "mobile_murders_2"]
    .every((column) => tied.places.every((place) => column.startsWith("mobile")));
  check(byLabelWouldTie, "the tied pair is genuinely indistinguishable by label, so the key is what separates them");
  const keyed = mapAgencyFigures(tied, ["year", "mobile_murders", "mobile_murders_2"],
    [{ year: 2023, mobile_murders: 4, mobile_murders_2: 9 }],
    [{ column: "mobile_murders", contractIndex: 0, placeLabel: "Mobile" },
     { column: "mobile_murders_2", contractIndex: 1, placeLabel: "Mobile" }]);
  check(
    (keyed?.members ?? []).every((entry) => entry.columns.length === 1),
    "and with the key each owns exactly one, which a label reading could not produce",
  );

  // Accepting ambiguous identity: a row with no ORI column must not be credited by name alone.
  const nameOnly = agencyFigureFailure(gc084Plan, ["place_label", "offenders"],
    [{ place_label: "Worcester County sheriff's office", offenders: 7 },
     { place_label: "Pocomoke City Police Department", offenders: 11 }]);
  check(
    Boolean(nameOnly) && nameOnly!.establishable === false,
    "names alone, with no ORI column, cannot establish membership even when both members are named",
  );

  // The live case still fires, so the rules are not inert.
  check(Boolean(agencyFigureFailure(gc084Plan, columns, rows)),
    "the real single-agency omission still stops, so none of the above passes by inertness");
}

console.log("\n9b - the query must bind the identifier to the figures beside it");
{
  /*
   * Every shape here returns rows that LOOK right: correctly spelled ORIs, correct state, both
   * requested agencies represented. What differs is whether the identifier and the number came from
   * the same records. Each is executed, so the check is made against what actually came back.
   */
  const shapes: { name: string; sql: string; deliver: boolean }[] = [
    {
      name: "honest: identifier and figure from one relation",
      deliver: true,
      sql: "SELECT d.ori, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori",
    },
    {
      name: "fabricated: identifier from a VALUES list, figure from the fact table",
      deliver: false,
      sql: "WITH requested(ori) AS (VALUES ('MD0240000'),('MD0240300')) " +
        "SELECT requested.ori, SUM(d.offender_count) AS offenders FROM requested " +
        "CROSS JOIN summary_offender_demographics d WHERE d.ori = 'MD0240000' AND d.year = 2023 " +
        "GROUP BY requested.ori",
    },
    {
      name: "directory: identifier from agencies, figure from the fact table, joined on nothing",
      deliver: false,
      sql: "SELECT a.ori, SUM(d.offender_count) AS offenders FROM agencies a " +
        "CROSS JOIN summary_offender_demographics d WHERE a.ori IN ('MD0240000','MD0240300') " +
        "AND a.year = 2023 AND d.ori = 'MD0240000' AND d.year = 2023 GROUP BY a.ori",
    },
    {
      name: "same table twice, tied on year only",
      deliver: false,
      sql: "SELECT d1.ori, SUM(d2.offender_count) AS offenders FROM summary_offender_demographics d1 " +
        "JOIN summary_offender_demographics d2 ON d2.year = d1.year " +
        "WHERE d1.ori IN ('MD0240000','MD0240300') AND d1.year = 2023 GROUP BY d1.ori",
    },
    {
      name: "same table twice, tied on the agency as well",
      deliver: true,
      sql: "SELECT d1.ori, SUM(d2.offender_count) AS offenders FROM summary_offender_demographics d1 " +
        "JOIN summary_offender_demographics d2 ON d2.year = d1.year AND d2.ori = d1.ori " +
        "WHERE d1.ori IN ('MD0240000','MD0240300') AND d1.year = 2023 GROUP BY d1.ori",
    },
    {
      // The genuine identifier IS projected -- under another name -- while the column the mapping
      // reads is a CASE that hands back the other agency's ORI. Finding a real reference somewhere in
      // the statement accepted this; only proving the RETURNED column stops it.
      name: "the real identifier projected beside a swapped one under the name that is read",
      deliver: false,
      sql: "SELECT d.ori AS actual_ori, CASE WHEN d.ori = 'MD0240000' THEN 'MD0240300' ELSE 'MD0240000' END AS ori, " +
        "SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023 GROUP BY d.ori",
    },
    {
      // Two CTEs each read the fact table as `d`. Those are different relation instances, and an
      // equality proved inside one scope says nothing about the other; the figure here is every
      // agency's total, attached to an identifier selected for one.
      name: "two scopes that each call the fact table d, joined on year only",
      deliver: false,
      sql: "WITH ids AS (SELECT d.ori, d.year FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023), " +
        "totals AS (SELECT d.year, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.year = 2023 GROUP BY d.year) " +
        "SELECT ids.ori, totals.offenders FROM ids INNER JOIN totals ON ids.year = totals.year",
    },
    {
      // THE OVER-REFUSAL COUNTERPART. One table, one instance, so a bare column can only have come
      // from it. Requiring the qualified spelling made syntax an answerability rule and refused this.
      name: "unqualified columns over a single source",
      deliver: true,
      sql: "SELECT ori, SUM(offender_count) AS offenders FROM summary_offender_demographics " +
        "WHERE ori IN ('MD0240000','MD0240300') AND year = 2023 GROUP BY ori",
    },
    {
      name: "an honest CTE that carries the agency through",
      deliver: true,
      sql: "WITH scoped AS (SELECT d.ori, d.year, d.offender_count FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023) " +
        "SELECT scoped.ori, SUM(scoped.offender_count) AS offenders FROM scoped GROUP BY scoped.ori",
    },
    {
      name: "an honest CTE that renames the agency column and names it back",
      deliver: true,
      sql: "WITH scoped AS (SELECT d.ori AS agency_ori, d.year, d.offender_count " +
        "FROM summary_offender_demographics d WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023) " +
        "SELECT scoped.agency_ori AS ori, SUM(scoped.offender_count) AS offenders FROM scoped GROUP BY scoped.agency_ori",
    },
    {
      // The identifier is genuine and the FIGURE is invented. Treating a literal as harmless because
      // it reads no relation -- it cannot carry another agency's rows -- misses that it carries no
      // agency's rows at all, and 999 arrives under two real ORIs.
      name: "a fabricated figure carried in a literal CTE beside a real identifier",
      deliver: false,
      sql: "WITH made(n) AS (VALUES (999)) SELECT d.ori, made.n AS offenders " +
        "FROM summary_offender_demographics d CROSS JOIN made " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023",
    },
    {
      // The same borrowing, spelled so the analyzer cannot resolve the figure's source at all. An
      // unreadable reference is not an absent one: dropping it left this statement with no measure to
      // check and delivered a countywide total as one agency's. Unproved must mean stopped.
      name: "two scopes joined on year only, in a spelling whose figure the analyzer cannot resolve",
      deliver: false,
      sql: "WITH ids AS (SELECT d.ori, d.year FROM summary_offender_demographics d " +
        "WHERE d.ori IN ('MD0240000','MD0240300') AND d.year = 2023), " +
        "totals AS (SELECT d.year, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d " +
        "WHERE d.year = 2023 GROUP BY d.year) " +
        "SELECT ids.ori, totals.offenders FROM ids JOIN totals ON ids.year = totals.year",
    },
  ];
  const shapeNamed = (name: string) => {
    const found = shapes.find((shape) => shape.name === name);
    if (!found) throw new Error(`no shape named ${name}`);
    return found;
  };

  for (const shape of shapes) {
    const rows = db.prepare(shape.sql).all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : ["ori", "offenders"];
    const failure = agencyFigureFailure(gc084Plan, columns, rows, null, shape.sql);
    check(
      (failure === null) === shape.deliver,
      `${shape.name}: ${rows.length} row(s) back, ${shape.deliver ? "delivered" : "stopped"}` +
        `${failure ? ` (${failure.reason.slice(0, 72)}…)` : ""}`,
    );
  }

  // The point of the fourth shape: its rows are indistinguishable from the honest one's, and both
  // name both agencies. Only the query separates them.
  const unlinked = db.prepare(shapeNamed("same table twice, tied on year only").sql).all() as Record<string, unknown>[];
  const honest = db.prepare(shapeNamed("honest: identifier and figure from one relation").sql).all() as Record<string, unknown>[];
  check(
    unlinked.length === honest.length
      && unlinked.every((row, index) => String(row.ori) === String(honest[index].ori)),
    "the unlinked query returns the same agencies as the honest one, so the rows cannot tell them apart",
  );
  check(
    JSON.stringify(unlinked) !== JSON.stringify(honest),
    `and its figures differ (${unlinked.map((r) => r.offenders).join()} against ${honest.map((r) => r.offenders).join()}), which is the harm`,
  );
  // Without the SQL there is nothing to prove the binding with, so the row check alone lets it pass.
  check(
    agencyFigureFailure(gc084Plan, Object.keys(unlinked[0]), unlinked) === null,
    "checking only the returned rows would have delivered it",
  );

  // WHAT THE SWAPPED SHAPE ACTUALLY RETURNS. The harm is not theoretical: each figure is real, and
  // each is filed under the other agency. Asserted on the executed rows so the stop is tied to the
  // damage rather than to the spelling of a rule.
  const swapped = db.prepare(shapeNamed("the real identifier projected beside a swapped one under the name that is read").sql)
    .all() as Record<string, unknown>[];
  check(
    swapped.length === 2
      && swapped.every((row) => String(row.ori) !== String(row.actual_ori))
      && swapped.some((row) => String(row.ori) === "MD0240300" && Number(row.offenders) === 7)
      && swapped.some((row) => String(row.ori) === "MD0240000" && Number(row.offenders) === 11),
    `the swapped shape files each agency's figure under the other (${swapped.map((r) => `${r.ori}:${r.offenders}`).join(", ")})`,
  );

  // AND WHAT THE UNQUALIFIED SHAPE RETURNS: the same rows as the qualified spelling. Refusing one
  // while delivering the other was a refusal of syntax, not of an unproved figure.
  const bare = db.prepare(shapeNamed("unqualified columns over a single source").sql).all() as Record<string, unknown>[];
  check(
    JSON.stringify(bare) === JSON.stringify(honest),
    `the unqualified spelling returns exactly the qualified one's rows (${bare.map((r) => `${r.ori}:${r.offenders}`).join(", ")})`,
  );
}

console.log("\n9c - two real agencies sharing one display name are not a contradiction");
{
  // The regression this carries: `Mobile` names two distinct AL agencies, and each honest row was
  // read as contradicting itself because the name lookup answered with the first matching member.
  const shared = {
    places: [
      { ...(gc084Plan!.places[0]), contractIndex: 0, label: "Mobile", requestedName: "Mobile, AL", state: "AL",
        status: "resolved" as const, oriYears: [{ year: 2023, ori: "AL0021300", population: 1 }] },
      { ...(gc084Plan!.places[1]), contractIndex: 1, label: "Mobile", requestedName: "Mobile, AL", state: "AL",
        status: "resolved" as const, oriYears: [{ year: 2023, ori: "AL0020000", population: 2 }] },
    ],
  } as NibrsPlaceResolutionPlan;
  const rows = [
    { ori: "AL0021300", place_label: "Mobile", offenders: 4 },
    { ori: "AL0020000", place_label: "Mobile", offenders: 9 },
  ];
  const mapping = mapAgencyFigures(shared, ["ori", "place_label", "offenders"], rows);
  check((mapping?.conflicts ?? []).length === 0, "the shared name raises no conflict");
  check(
    (mapping?.members ?? []).every((entry) => entry.rowCount === 1),
    "each agency keeps its own row",
  );
  check(
    agencyFigureFailure(shared, ["ori", "place_label", "offenders"], rows) === null,
    "and the honest answer is delivered, not refused",
  );
  // A name that genuinely does not fit the row's own agency is still a contradiction.
  const wrong = [{ ori: "AL0021300", place_label: "Pocomoke City Police Department", offenders: 4 }];
  const wrongMapping = mapAgencyFigures(gc084Plan, ["ori", "place_label", "offenders"],
    [{ ori: "MD0240000", place_label: "Pocomoke City Police Department", offenders: 7 }]);
  check(
    (wrongMapping?.conflicts ?? []).some((text) => /by ORI and/.test(text)),
    "while a name belonging to a different agency still contradicts its row",
  );
  void wrong;
}

console.log("\n10 - the refusal says which of three things went wrong");
{
  // Collapsing these produced "only cover  - nothing came back for Mobile": conflicting identity
  // evidence read as a proven subset, with an empty list where the covered agencies should be.
  const subset = memberRefusalText({
    reason: "x", present: ["Worcester County sheriff's office"], missing: ["Pocomoke City Police Department"],
    establishable: true,
  });
  check(/only cover Worcester County sheriff's office/.test(subset) && /nothing in the result belongs to Pocomoke/.test(subset),
    "a genuine subset names what is covered and what is not");

  const unidentifiable = memberRefusalText({ reason: "x", present: [], missing: [], establishable: false });
  check(
    /don't identify which agency/.test(unidentifiable) && !/nothing in the result belongs to/.test(unidentifiable),
    "an unidentifiable result says so, and does not assert that any agency is absent",
  );

  const conflicted = memberRefusalText({
    reason: "a row identifies A by ORI and B by place_label", present: [], missing: ["Mobile"], establishable: true,
  });
  check(
    /don't agree/.test(conflicted) && !/only cover\s+—/.test(conflicted) && !/nothing in the result belongs to/.test(conflicted),
    "conflicting identity is reported as disagreement, not as a subset with an empty covered list",
  );
  check(
    !/only cover\s*(?:—|-)\s/.test(subset + unidentifiable + conflicted),
    "and no message renders an empty list where agencies should be named",
  );
}

console.log("\n11 - the missing-member note survives the internal-leak firewall");
{
  const safePlan = {
    places: [
      { ...(gc084Plan!.places[0]), contractIndex: 0, label: "Albuquerque police department",
        status: "resolved" as const, oriYears: [{ year: 2023, ori: ABQ, population: 1 }] },
      { ...(gc084Plan!.places[1]), contractIndex: 1, label: "Cambridge, MD",
        status: "not_in_source" as const, oriYears: [] },
    ],
  } as NibrsPlaceResolutionPlan;
  const safe = unresolvedMemberDisclosure(safePlan);
  check(Boolean(safe) && /Cambridge/.test(safe!.note), "an ordinary missing agency is named in the note");
  check(Boolean(safe) && safe!.unsafeLabel === false, "and is marked as safe to render");

  // TWO DIFFERENT LIMITATIONS, AND THE NOTE MUST NOT SWAP ONE FOR THE OTHER.
  // `covered` is the resolver's own word for an agency it DID identify, which simply has no rows in
  // the requested years. Describing it as one that could not be matched told the reader the source
  // does not know the agency -- the opposite of what the resolver recorded, and it hid that a
  // different year is the thing that would fix it.
  const coveredPlan = {
    ...safePlan,
    startYear: 2021,
    endYear: 2025,
    places: safePlan.places.map((place, index) =>
      index === 1
        ? { ...place, status: "covered" as const, reason: "Known agency, no rows for the requested year." }
        : place),
  } as NibrsPlaceResolutionPlan;
  const coveredNote = unresolvedMemberDisclosure(coveredPlan);
  // Stated positively as well as negatively on purpose. A purely negative form ("does not say it
  // could not be matched") is satisfied by a note that says nothing about the agency at all, which is
  // a worse outcome than the wording it was meant to catch.
  check(
    Boolean(coveredNote) && /Cambridge/.test(coveredNote!.note) && !/could not be matched/.test(coveredNote!.note),
    `a known agency with no rows in the period is still named, and is not called unidentifiable (${coveredNote?.note ?? "no note"})`,
  );
  check(
    Boolean(coveredNote) && /known agency/.test(coveredNote!.note) && /2021-2025/.test(coveredNote!.note),
    "it is described as having no data for the period that was asked about",
  );
  check(
    Boolean(coveredNote) && /not included in these figures/.test(coveredNote!.note),
    "and it is still disclosed as absent from the numbers, not quietly dropped",
  );
  // The control: the two causes stay distinct when both are present, rather than collapsing.
  const mixedPlan = {
    ...coveredPlan,
    places: [
      coveredPlan.places[0],
      coveredPlan.places[1],
      { ...coveredPlan.places[1], contractIndex: 2, label: "Salisbury police department", status: "not_in_source" as const },
    ],
  } as NibrsPlaceResolutionPlan;
  const mixedNote = unresolvedMemberDisclosure(mixedPlan);
  check(
    Boolean(mixedNote) && /could not be matched/.test(mixedNote!.note) && /known agency/.test(mixedNote!.note),
    "an unmatched agency and an unavailable-period agency are reported as different facts in one note",
  );
  // No arrangement of statuses may render the sentence with its reason missing -- the same standard
  // section 10 holds the refusal messages to.
  for (const [label, note] of [["unavailable only", coveredNote], ["mixed", mixedNote]] as const) {
    check(
      Boolean(note) && !/\.\s*,\s*so /.test(note!.note) && !/only\.\s*,/.test(note!.note),
      `the ${label} note states a reason rather than an empty clause`,
    );
  }
  const safeThroughFirewall = sanitizeUserFacingNarrative(`Here are the figures.\n\n${safe!.note}`, "Murders by year");
  check(
    !safeThroughFirewall.blocked && String(safeThroughFirewall.explanation).includes(safe!.note),
    "it passes the firewall unchanged",
  );

  // A label carrying an internal table name. Naming it would make the firewall replace the entire
  // explanation with its safe message, deleting the limitation while the route recorded a disclosure.
  const unsafePlan = {
    places: [
      { ...(safePlan.places[0]) },
      { ...(safePlan.places[1]), label: "summary_offender_demographics" },
    ],
  } as NibrsPlaceResolutionPlan;
  const unsafe = unresolvedMemberDisclosure(unsafePlan);
  check(Boolean(unsafe) && unsafe!.unsafeLabel === true, "an unrenderable label is detected");
  check(
    Boolean(unsafe) && !unsafe!.note.includes("summary_offender_demographics"),
    "the note does not carry the unsafe text",
  );
  check(
    Boolean(unsafe) && /could not be matched to an agency in this data/.test(unsafe!.note),
    "but it still states the limitation rather than dropping it",
  );
  const unsafeThroughFirewall = sanitizeUserFacingNarrative(`Here are the figures.\n\n${unsafe!.note}`, "Murders by year");
  check(
    !unsafeThroughFirewall.blocked && String(unsafeThroughFirewall.explanation).includes(unsafe!.note),
    "and it survives the firewall, which the naming version would not have",
  );
  // The control: the firewall really would have blocked the naming version.
  const naming = `Here are the figures.\n\nsummary_offender_demographics was also asked about.`;
  check(
    sanitizeUserFacingNarrative(naming, "Murders by year").blocked,
    "the firewall does block a note that names it, so this is not a vacuous check",
  );
}

db.close();
console.log(`\nagency figure mapping: ${checks - failures} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
