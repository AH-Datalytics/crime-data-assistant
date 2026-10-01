/*
 * Who is allowed to answer a multi-agency question, and does the title say what the answer covers?
 *
 * The rule under test is a change of guarantee, not another check on generated SQL. Three earlier
 * attempts tried to prove from query text that each number sat beside the right agency; each was
 * defeated by wrapping the same substitution one level further. So the witnesses here are not asked
 * whether their SQL is honest. They are asked who built the answer. A model-written comparison is
 * refused whether it is honest or not, and both kinds appear below so that cost is visible in the
 * suite rather than described in a document.
 *
 * Single-agency questions and the peer-selection family are asserted UNCHANGED, because a restriction
 * that quietly widened to them would be a much worse defect than the one it fixes.
 */
import {
  isOwnedMultiAgencyRequest,
  ownedMemberDeclaration,
  memberCoverage,
  coverageTitle,
  coverageNote,
  unsupportedOwnedComparisonText,
  type MemberCoverage,
  type MemberDeclaration,
} from "../lib/agency-answer-ownership";
import { mapAgencyFigures } from "../lib/nibrs-member-figures";
import { sanitizeUserFacingNarrative } from "../lib/scaffold-helpers";
import type { NibrsPlaceResolutionPlan } from "../lib/nibrs-place-resolver";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const place = (index: number, label: string, ori: string, status = "resolved", state = "NM") => ({
  contractIndex: index,
  requestedName: label,
  label,
  state,
  kind: index ? "sheriff" : "city_police",
  status,
  confidence: "high",
  oriYears: status === "resolved" ? [{ year: 2020, ori, population: 100000 }] : [],
  oriRanges: status === "resolved" ? [{ ori, startYear: 2020, endYear: 2024 }] : [],
  reason: "fixture",
});
const planOf = (places: unknown[], startYear = 2020, endYear = 2024) => ({
  question: "fixture", startYear, endYear, places, hasStateComparison: false, elapsedMs: 0,
} as unknown as NibrsPlaceResolutionPlan);

const ABQ = "NM0010100", BCS = "NM0010000";
const twoResolved = planOf([place(0, "Albuquerque police department", ABQ), place(1, "Bernalillo county sheriff", BCS)]);
const declared = [
  { column: "albuquerque_police_department_murders", placeKey: "place_1", contractIndex: 0 },
  { column: "bernalillo_county_sheriff_murders", placeKey: "place_2", contractIndex: 1 },
];
const bothRows = [{ year: 2020, albuquerque_police_department_murders: 76, bernalillo_county_sheriff_murders: 8 }];
const OWNED_SQL = "SELECT 1 /* producer */";
const producer = { sql: OWNED_SQL, guardrail: "deterministic-nibrs-structured-local-trend", memberColumns: declared };
const coverageFor = (plan: NibrsPlaceResolutionPlan, columns: string[], rows: Record<string, unknown>[], decl: MemberDeclaration[] | null) =>
  memberCoverage(plan, mapAgencyFigures(plan, columns, rows, decl));

console.log("\n1 - the family is taken from the request, not from wording or from the result");
{
  check(isOwnedMultiAgencyRequest(twoResolved), "two requested agencies is the bounded family");
  check(
    !isOwnedMultiAgencyRequest(planOf([place(0, "Albuquerque police department", ABQ)])),
    "one requested agency is not, so single-agency questions are untouched",
  );
  // The peer family names ONE agency and asks the product to choose the comparison group; its places
  // list therefore holds one member, and its own policy continues to govern it.
  check(
    !isOwnedMultiAgencyRequest(planOf([place(0, "San Francisco Police Department", "CA0380100")])),
    "a peer-selection request has one requested place, so this restriction does not reach it",
  );
  check(!isOwnedMultiAgencyRequest(null), "no plan is not a multi-agency request");
  // Two ROWS are not two requested members. Whoever wrote the query decides how many rows come back.
  const oneRequested = planOf([place(0, "Albuquerque police department", ABQ)]);
  check(
    !isOwnedMultiAgencyRequest(oneRequested),
    "a single-member request stays outside the family however many rows its answer holds",
  );
}

console.log("\n2 - only a producer declaration bound to the executed statement is trusted");
{
  check(ownedMemberDeclaration(producer, OWNED_SQL) !== null, "the producer's own declaration, on the statement it built, is accepted");
  check(
    ownedMemberDeclaration(producer, "SELECT 1 /* rewritten */") === null,
    "the SAME declaration is refused once the executed statement differs — a rewrite cannot inherit it",
  );
  check(
    ownedMemberDeclaration({ ...producer, guardrail: null }, OWNED_SQL) === null,
    "a declaration carrying no owned producer family is refused",
  );
  check(
    ownedMemberDeclaration({ sql: OWNED_SQL, guardrail: "x", memberColumns: [] }, OWNED_SQL) === null,
    "an empty declaration is refused, so a nonempty property is not the test",
  );
  // A forged declaration: correct column names, member identified only by a LABEL. Two real agencies
  // can share one label, so a label cannot carry the binding and is refused here rather than at the
  // point where it would silently pick the first match.
  check(
    ownedMemberDeclaration({ ...producer, memberColumns: [{ column: "albuquerque_police_department_murders", placeLabel: "Albuquerque police department" }] }, OWNED_SQL) === null,
    "a declaration naming its member by label instead of index is refused",
  );
  check(
    ownedMemberDeclaration(null, OWNED_SQL) === null && ownedMemberDeclaration(producer, null) === null,
    "a missing query or missing executed statement is refused, not defaulted",
  );
}

console.log("\n3 - the accepted supported comparison is preserved exactly");
{
  const coverage = coverageFor(twoResolved, Object.keys(bothRows[0]), bothRows, declared);
  check(coverage.every((entry) => entry.state === "figures"), "both members are covered by figures");
  const title = "NIBRS offense trends for Albuquerque police department and Bernalillo county sheriff";
  check(coverageTitle(title, coverage) === title, "a complete answer keeps its producer's title unchanged");
  check(coverageNote(twoResolved, coverage) === null, "and says nothing about coverage, because nothing is missing");
}

console.log("\n4 - a partial answer is marked, and its supported figures are kept");
{
  const plan = planOf([place(0, "Albuquerque police department", ABQ), place(1, "Cambridge police department", "", "not_in_source", "MA")]);
  const rows = [{ year: 2020, albuquerque_police_department_murders: 76, cambridge_police_department_murders: null }];
  const coverage = coverageFor(plan, Object.keys(rows[0]), rows, declared.slice(0, 1));
  check(coverage[0].state === "figures" && coverage[1].state === "unmatched", "one member has figures, the other is unmatched");
  const title = coverageTitle("NIBRS offense trends", coverage);
  check(!/Cambridge/i.test(title), "the title does not claim the member the answer does not cover");
  check(/1 of 2 agencies requested/.test(title), `and marks the answer partial (${title})`);
  check(/Albuquerque/.test(title), "while still naming the member it does cover");
  const note = coverageNote(plan, coverage);
  check(Boolean(note) && /could not be matched to an agency in this data/.test(note!.note), "the note gives the unmatched cause");
  check(rows[0].albuquerque_police_department_murders === 76, "the supported figure is not discarded to make the answer safe");
}

console.log("\n5 - four causes, kept apart");
{
  const plan = planOf([
    place(0, "Albuquerque police department", ABQ),
    place(1, "Cambridge police department", "", "not_in_source", "MA"),
    place(2, "Pocomoke City police department", "", "covered", "MD"),
    place(3, "Bernalillo county sheriff", BCS),
  ], 2021, 2025);
  // Member 3 resolves and is declared, but every one of its values is absent: a contribution that did
  // not arrive, which is neither the agency's absence nor a zero.
  const rows = [{ year: 2021, albuquerque_police_department_murders: 76, bernalillo_county_sheriff_murders: null }];
  const decl = [declared[0], { column: "bernalillo_county_sheriff_murders", contractIndex: 3 }];
  const coverage = coverageFor(plan, Object.keys(rows[0]), rows, decl);
  const states = coverage.map((entry) => entry.state);
  check(states[0] === "figures", "the covered member reads as covered");
  check(states[1] === "unmatched", "the absent agency reads as unmatched");
  check(states[2] === "unavailable-period", "the known agency with no rows reads as an unavailable period");
  check(states[3] === "no-contribution", `the declared member with only empty cells reads as no contribution (${states[3]})`);
  const note = coverageNote(plan, coverage)!;
  check(/could not be matched/.test(note.note), "the note states the unmatched cause");
  check(/known agency that has no data in this source for 2021-2025/.test(note.note), "the unavailable period, with the period named");
  check(/returned no figures for this request/.test(note.note), "and the missing contribution, as its own cause");
  check(/1 of 4 agencies requested/.test(coverageTitle("NIBRS offense trends", coverage)), "the title counts only the member with figures");
}

console.log("\n6 - a genuine zero is a figure, not an absence");
{
  const rows = [{ year: 2020, albuquerque_police_department_murders: 0, bernalillo_county_sheriff_murders: 0 }];
  const coverage = coverageFor(twoResolved, Object.keys(rows[0]), rows, declared);
  check(coverage.every((entry) => entry.state === "figures"), "zero counts are covered members, not missing ones");
  const title = "NIBRS offense trends for Albuquerque police department and Bernalillo county sheriff";
  check(coverageTitle(title, coverage) === title, "so an all-zero answer keeps its unqualified title");
  check(coverageNote(twoResolved, coverage) === null, "and discloses no shortfall");
  const nulls = [{ year: 2020, albuquerque_police_department_murders: null, bernalillo_county_sheriff_murders: null }];
  const nullCoverage = coverageFor(twoResolved, Object.keys(nulls[0]), nulls, declared);
  check(
    nullCoverage.every((entry) => entry.state === "no-contribution"),
    "while the same shape with empty cells is not reported as zeroes",
  );
  check(
    /no agency figures returned/.test(coverageTitle("NIBRS offense trends", nullCoverage)),
    "and its title claims no coverage at all",
  );
}

console.log("\n7 - the restriction message describes our limit, not the source's contents");
{
  const msg = unsupportedOwnedComparisonText();
  check(/more than one agency/i.test(msg), "it says what kind of request stopped");
  check(
    !/(not in|no such|does not have|doesn't have|lacks|no data)/i.test(msg),
    "it makes no claim about what the source contains",
  );
  check(/limit of what I can put together/i.test(msg), "it attributes the limit to us");
  check(
    !/(will work|I can answer each|splitting)/i.test(msg),
    "and promises nothing about one-at-a-time working, which for the original case it would not have",
  );
  check(!sanitizeUserFacingNarrative(msg, "").blocked, "and it passes the internal-leak firewall");
}

console.log("\n8 - an unrenderable label never turns a partial answer into an unqualified claim");
{
  const plan = planOf([
    place(0, "Albuquerque police department", ABQ),
    place(1, "summary_offender_demographics", "", "not_in_source", "MA"),
  ]);
  const rows = [{ year: 2020, albuquerque_police_department_murders: 76 }];
  const coverage = coverageFor(plan, Object.keys(rows[0]), rows, declared.slice(0, 1));
  const note = coverageNote(plan, coverage)!;
  check(note.unsafeLabel === true, "the unrenderable label is detected");
  check(!note.note.includes("summary_offender_demographics"), "the note does not carry it");
  check(/another agency you named/.test(note.note), "it is described by count instead");
  check(!sanitizeUserFacingNarrative(`Figures.\n\n${note.note}`, "T").blocked, "so the note survives the firewall");
  const title = coverageTitle("NIBRS offense trends", coverage);
  check(!title.includes("summary_offender_demographics"), "the title does not carry it either");
  check(/1 of 2 agencies requested/.test(title), "and the answer is still marked partial rather than claiming both");
}

console.log("\n9 - the GC-084 shape: a one-agency result is not the complete two-agency answer");
{
  // The original shipped answer: one ORI queried, no identity column at all, both agencies requested.
  const plan = planOf([
    place(0, "Worcester County sheriff's office", "MD0240000", "resolved", "MD"),
    place(1, "Pocomoke City police department", "MD0240300", "resolved", "MD"),
  ], 2021, 2025);
  const rows = [{ age_group: "25-34", offenders: 26 }, { age_group: "18-24", offenders: 24 }];
  const coverage = coverageFor(plan, ["age_group", "offenders"], rows, null);
  check(
    coverage.every((entry) => entry.state === "unresolved-ownership"),
    "with no identity column, neither member's ownership is established",
  );
  const title = coverageTitle("Violent crime by offender age", coverage);
  check(/no agency figures returned/.test(title), `so the title claims no agency coverage (${title})`);
  check(!/Worcester|Pocomoke/.test(title), "and names neither agency as covered");
  const note = coverageNote(plan, coverage)!;
  check(/could not be tied to any figures/.test(note.note), "the note says ownership could not be established");
  check(
    !/could not be matched to an agency in this data/.test(note.note),
    "and does not assert the source lacks either agency, which nothing here established",
  );
  check(isOwnedMultiAgencyRequest(plan), "and the request is in the family, so the model path stops before producing this at all");
}

console.log("\n10 - the title is composed the producer's way, across the sizes the builder supports");
{
  // The supported builder joins EVERY member with " and " and accepts up to four geographies. An
  // earlier version of `coverageTitle` rebuilt that list with a prose joiner ("A, B and C"); at two
  // members the two agree, so the difference only appeared at three -- where the suffix matched
  // nothing, the producer's original list survived, and the coverage clause was appended after it.
  // The delivered title then named the uncovered agency and repeated the covered ones.
  const label = (n: number) => `Agency ${n} police department`;
  const producerList = (n: number) => Array.from({ length: n }, (_, i) => label(i + 1)).join(" and ");
  for (const size of [2, 3, 4]) {
    const coverage = Array.from({ length: size }, (_, i) => ({
      member: { label: label(i + 1) },
      state: i === size - 1 ? "unmatched" : "figures",
    })) as unknown as MemberCoverage[];
    const title = coverageTitle(`NIBRS offense trends for ${producerList(size)}`, coverage);
    check(
      !title.includes(label(size)),
      `${size} members: the uncovered agency is gone from the title (${title})`,
    );
    check(
      title.split(label(1)).length - 1 === 1,
      `${size} members: no covered agency is named twice`,
    );
    check(
      title.startsWith("NIBRS offense trends for ") && new RegExp(`\\(${size - 1} of ${size} agencies requested\\)$`).test(title),
      `${size} members: subject preserved and coverage stated once`,
    );
  }
  // A complete answer at each size keeps its producer's title exactly.
  for (const size of [2, 3, 4]) {
    const coverage = Array.from({ length: size }, (_, i) => ({ member: { label: label(i + 1) }, state: "figures" })) as unknown as MemberCoverage[];
    const producerTitle = `NIBRS offense trends for ${producerList(size)}`;
    check(coverageTitle(producerTitle, coverage) === producerTitle, `${size} members, all covered: the title is untouched`);
  }
  // No figures at all, at three members: the subject survives and no agency is claimed.
  const noneCoverage = Array.from({ length: 3 }, (_, i) => ({ member: { label: label(i + 1) }, state: "unresolved-ownership" })) as unknown as MemberCoverage[];
  const noneTitle = coverageTitle(`NIBRS offense trends for ${producerList(3)}`, noneCoverage);
  check(/^NIBRS offense trends — no agency figures returned$/.test(noneTitle), `three members with nothing bound claims no coverage (${noneTitle})`);
  // Genuine zeroes are figures at three members too, so an all-zero comparison stays unqualified.
  const zeroPlan = planOf([place(0, label(1), ABQ), place(1, label(2), BCS), place(2, label(3), "NM0010200")]);
  const zeroRows = [{ year: 2020, a: 0, b: 0, c: 0 }];
  const zeroDecl = [{ column: "a", contractIndex: 0 }, { column: "b", contractIndex: 1 }, { column: "c", contractIndex: 2 }];
  const zeroCoverage = coverageFor(zeroPlan, Object.keys(zeroRows[0]), zeroRows, zeroDecl);
  const zeroTitle = `NIBRS offense trends for ${producerList(3)}`;
  check(coverageTitle(zeroTitle, zeroCoverage) === zeroTitle, "three members reporting zero keep the unqualified title");
  // An unsafe label among the covered members: the names are dropped, the count is not.
  const unsafeCoverage = [
    { member: { label: "summary_offender_demographics" }, state: "figures" },
    { member: { label: label(2) }, state: "figures" },
    { member: { label: label(3) }, state: "unmatched" },
  ] as unknown as MemberCoverage[];
  const unsafeTitle = coverageTitle(`NIBRS offense trends for summary_offender_demographics and ${label(2)} and ${label(3)}`, unsafeCoverage);
  check(!unsafeTitle.includes("summary_offender_demographics"), "an unrenderable covered label is not written into the title");
  check(/\(2 of 3 agencies requested\)$/.test(unsafeTitle), `and the coverage count is still stated (${unsafeTitle})`);
}

console.log(`\nagency answer ownership: ${checks - failures} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
