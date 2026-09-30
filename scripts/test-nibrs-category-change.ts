/**
 * GC-065: the owned violent-category comparison (lib/nibrs-category-change.ts), run end to end on an
 * in-memory database with the production column layout, through the same function the route calls.
 *
 * Expected values are written from the rows each case inserts, not read back from the output.
 */
import assert from "node:assert";
import Database from "better-sqlite3";
import { planCategoryChange, recognizeCategoryChange, runOwnedCategoryChange, unownedWords, type CategoryChangePlan } from "../lib/nibrs-category-change";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";
import type { NibrsPlaceResolutionPlan } from "../lib/nibrs-place-resolver";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message.split("\n")[0]}`); }
}

const GC065 = "Which violent crime saw the greatest decrease in Chicago in 2025?";

function resolution(oris: { ori: string; year: number }[], startYear = 2024, endYear = 2025): NibrsPlaceResolutionPlan {
  return {
    question: GC065, startYear, endYear, hasStateComparison: false, elapsedMs: 0,
    places: [{ contractIndex: 0, requestedName: "Chicago", label: "Chicago, IL", state: "IL", kind: "city_police",
      status: "resolved", confidence: "high", oriYears: oris.map((o) => ({ ...o, population: 2_700_000 })), oriRanges: [], reason: "" }],
  };
}

type Seed = { persons?: [string, string, number, number][]; offenses?: [string, string, number, number][]; completeness?: [string, number, number][] };
function database(seed: Seed): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE summary_victim_city_monthly (year INTEGER, month INTEGER, state TEXT, ori TEXT, ucr_offense_code TEXT, victim_count INTEGER);
            CREATE TABLE summary_city_monthly (year INTEGER, month INTEGER, state TEXT, ori TEXT, ucr_offense_code TEXT, offense_count INTEGER);
            CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER, total_offenses INTEGER);`);
  // Each annual count is split across two months so the SUM is exercised, not a single row read back.
  const split = (n: number) => [Math.floor(n / 2), n - Math.floor(n / 2)];
  for (const [ori, code, year, n] of seed.persons ?? []) split(n).forEach((v, i) =>
    db.prepare("INSERT INTO summary_victim_city_monthly VALUES (?, ?, 'IL', ?, ?, ?)").run(year, i + 1, ori, code, v));
  for (const [ori, code, year, n] of seed.offenses ?? []) split(n).forEach((v, i) =>
    db.prepare("INSERT INTO summary_city_monthly VALUES (?, ?, 'IL', ?, ?, ?)").run(year, i + 1, ori, code, v));
  for (const [ori, year, months] of seed.completeness ?? []) db.prepare("INSERT INTO nibrs_agency_completeness VALUES (?, ?, ?, 0)").run(ori, year, months);
  return db;
}

function plan(question: string, oris: { ori: string; year: number }[]): CategoryChangePlan {
  const request = recognizeCategoryChange(question);
  assert.ok(request && request.kind === "request", `not recognized: ${question}`);
  const p = planCategoryChange(request, resolution(oris, request.prior, request.year));
  assert.strictEqual(p.kind, "plan");
  return p as CategoryChangePlan;
}

const CHICAGO = [{ ori: "ILCPD0000", year: 2024 }, { ori: "ILCPD0000", year: 2025 }];
// The retained GC-065 values (handoff table, line ~12388): robbery counted as offenses, the person
// crimes as victims; 11B and 11C have no rows in either year.
const RETAINED: Seed = {
  persons: [["ILCPD0000", "13A", 2024, 3437], ["ILCPD0000", "13A", 2025, 2545], ["ILCPD0000", "09A", 2024, 461], ["ILCPD0000", "09A", 2025, 338],
            ["ILCPD0000", "11A", 2024, 1523], ["ILCPD0000", "11A", 2025, 1535]],
  offenses: [["ILCPD0000", "120", 2024, 8874], ["ILCPD0000", "120", 2025, 5682]],
  completeness: [["ILCPD0000", 2024, 12], ["ILCPD0000", 2025, 12]],
};

function runner(db: Database.Database, counter = { n: 0 }, refuse: (s: string) => boolean = () => false) {
  return {
    refusal: (s: string) => (refuse(s) ? { ruleIds: ["test-refusal"] } : null),
    execute: async (s: string) => { counter.n += 1; return db.prepare(s).all() as Record<string, unknown>[]; },
  };
}

async function main() {
  console.log("\n-- recognition --");
  await check("GC-065 is recognized as a 2024-to-2025 decrease", () => {
    assert.deepStrictEqual(recognizeCategoryChange(GC065), { kind: "request", direction: "decrease", prior: 2024, year: 2025 });
  });
  await check("siblings: an increase, and an explicit two-year range", () => {
    assert.deepStrictEqual(recognizeCategoryChange("Which violent crime saw the biggest increase in Chicago in 2025?"),
      { kind: "request", direction: "increase", prior: 2024, year: 2025 });
    assert.deepStrictEqual(recognizeCategoryChange("What violent crime dropped the most in Chicago between 2023 and 2025?"),
      { kind: "request", direction: "decrease", prior: 2023, year: 2025 });
  });
  await check("no stated year is an owned request for the year, not a guessed period", () => {
    const r = recognizeCategoryChange("Which violent crime saw the greatest decrease in Chicago?");
    assert.strictEqual(r?.kind, "unsupported");
  });
  // CL1: a period, unit or scope the family cannot answer is declined in words that name it, never
  // answered with the annual count for a different question.
  for (const [q, said] of [
    ["Which violent crime saw the greatest decrease in Chicago between January and March 2025?", /part of a year/],
    ["Which violent crime saw the greatest decrease in Chicago in the first quarter of 2025?", /part of a year/],
    ["Which violent crime saw the greatest decrease in Chicago in 2025, in percentage terms?", /a percentage or share/],
    ["Which violent crime saw the greatest decrease per capita in Chicago in 2025?", /a rate/],
    ["Which violent crime saw the greatest decrease in Chicago since 2020?", /two complete years/],
    ["Which violent crime saw the greatest decrease in Chicago in 2026?", /still in progress/],
    ["Which violent crime against juveniles saw the greatest decrease in Chicago in 2025?", /group or dimension/],
    ["Which violent crime saw the greatest decrease in Chicago in 2025 by race?", /group or dimension/],
  ] as const) {
    await check(`CL1: declined, not answered annually: "${q.slice(35)}"`, () => {
      const r = recognizeCategoryChange(q);
      assert.ok(r && r.kind === "unsupported", `recognized as ${JSON.stringify(r)}`);
      assert.match(r.explanation, said);
    });
  }
  // CR-1: positive whole-form admission -- a restriction the family does not apply is named and declined.
  for (const [q, phrase] of [
    ["Which violent crime with a gun saw the greatest decrease in Chicago in 2025?", "with a gun"],
    ["Which violent crime saw the greatest decrease at night in Chicago in 2025?", "at night"],
    ["Which violent crime involving strangers saw the greatest decrease in Chicago in 2025?", "involving strangers"],
    ["Which violent crime saw the greatest decrease in Chicago schools in 2025?", "schools"],
  ] as const) {
    await check(`CR-1: an unowned restriction is named, not answered with totals: "${phrase}"`, () => {
      const r = recognizeCategoryChange(q);
      assert.ok(r && r.kind === "unsupported", `recognized as ${JSON.stringify(r)}`);
      assert.ok(r.explanation.includes(`"${phrase}"`), r.explanation);
    });
  }
  await check("CR-1: every supported form is wholly owned (nothing left over)", () => {
    for (const q of [GC065, "Which violent crime saw the biggest increase in Chicago in 2025?",
      "What violent crime dropped the most in Chicago between 2023 and 2025?",
      "Which violent crime saw the greatest decrease in Chicago in 2025 compared with 2024?",
      "Which violent crime category saw the largest drop in Houston, TX in 2024?",
      "what violent crimes decreased the most in New York City in 2025"]) {
      assert.deepStrictEqual(unownedWords(q), [], q);
      assert.strictEqual(recognizeCategoryChange(q)?.kind, "request", q);
    }
  });
  await check("CL1: the full-year and two-year requests are unchanged", () => {
    assert.deepStrictEqual(recognizeCategoryChange(GC065), { kind: "request", direction: "decrease", prior: 2024, year: 2025 });
    assert.deepStrictEqual(recognizeCategoryChange("Which violent crime saw the greatest decrease in Chicago in 2024 compared with 2023?"),
      { kind: "request", direction: "decrease", prior: 2023, year: 2024 });
  });
  await check("a property-crime comparison is not claimed by this violent-only family", () => {
    assert.strictEqual(recognizeCategoryChange("Which property crime saw the greatest decrease in Chicago in 2025?"), null);
  });
  await check("two named places, or an unresolved one, are declined rather than merged", () => {
    const request = recognizeCategoryChange(GC065);
    assert.ok(request && request.kind === "request");
    const two = resolution(CHICAGO);
    two.places.push({ ...two.places[0], contractIndex: 1, label: "Houston, TX" });
    assert.strictEqual(planCategoryChange(request, two).kind, "unsupported");
    const unresolved = resolution(CHICAGO);
    unresolved.places[0].status = "ambiguous" as never;
    assert.strictEqual(planCategoryChange(request, unresolved).kind, "unsupported");
  });
  await check("a place resolved over only the asked year cannot be planned (the prior year's ORIs would be missing)", () => {
    const request = recognizeCategoryChange(GC065);
    assert.ok(request && request.kind === "request");
    assert.throws(() => planCategoryChange(request, resolution([{ ori: "ILCPD0000", year: 2025 }], 2025, 2025)));
  });

  console.log("\n-- the statements pass the route's structural proof --");
  await check("every statement, as planned and as restricted, is accepted by deterministicPlanRefusal", async () => {
    const p = plan(GC065, CHICAGO);
    const seen: string[] = [];
    const db = database(RETAINED);
    await runOwnedCategoryChange({ plan: p, refusal: (s) => { seen.push(s); return null; },
      execute: async (s) => db.prepare(s).all() as Record<string, unknown>[] });
    assert.strictEqual(seen.length, 3);
    for (const s of seen) assert.strictEqual(deterministicPlanRefusal({ question: GC065, source: "nibrs", sql: s }), null, s);
  });

  console.log("\n-- the answer --");
  await check("GC-065 on the retained values: robbery decreased the most, 8,874 to 5,682 offenses (−3,192)", async () => {
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(RETAINED)) });
    assert.strictEqual(out.kind, "answer");
    if (out.kind !== "answer") return;
    assert.match(out.explanation, /robbery \(120\) decreased the most, from 8,874 to 5,682 offenses \(−3,192\)/);
    const byCode = Object.fromEntries(out.rows.map((r) => [r.code, r]));
    assert.strictEqual(byCode["120"].change, 5682 - 8874);
    assert.strictEqual(byCode["13A"].change, 2545 - 3437);
    assert.strictEqual(byCode["09A"].change, 338 - 461);
    assert.strictEqual(byCode["11A"].change, 1535 - 1523);
    assert.strictEqual(byCode["120"].unit, "offenses");
    assert.strictEqual(byCode["13A"].unit, "victims");
  });
  await check("11B and 11C have no rows: stated as unknown and not compared, never as zero", async () => {
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(RETAINED)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.deepStrictEqual(out.absent, ["11B", "11C"]);
    for (const code of ["11B", "11C"]) {
      const row: Record<string, unknown> = out.rows.find((r) => r.code === code)!;
      assert.strictEqual(row.change, null);
      assert.strictEqual(row[`count_2024`], null);
      assert.strictEqual(row.status, "no records (unknown)");
    }
    assert.match(out.explanation, /\(11B\) and .*\(11C\) have no records in either year for the agencies compared. .*Those categories are not compared/);
    assert.match(out.explanation, /what a missing row means in this source is not established/);
    // CL4 / S2: no claim about how the rows were produced.
    assert.doesNotMatch(out.explanation, /stores no row|producer/);
    assert.match(out.explanation, /does not rule out a larger change there/);
    assert.doesNotMatch(out.explanation, /11B[^.;]*\b0\b/);
  });
  await check("the exclusion is stated with its count even when nothing is excluded", async () => {
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(RETAINED)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.match(out.explanation, /Excluded from the comparison: 0 of 1 agency for Chicago, IL\. Compared: ILCPD0000, with 12 of 12 months with at least one recorded offense in both years\./);
    assert.match(out.explanation, /victims for the crimes against persons, offenses for robbery/);
  });
  await check("a robbery row in the victim table (the withdrawn comparison's source) is not what is counted", async () => {
    const decoy: Seed = { ...RETAINED, persons: [...RETAINED.persons!, ["ILCPD0000", "120", 2024, 9000], ["ILCPD0000", "120", 2025, 100]] };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(decoy)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.strictEqual(out.rows.find((r) => r.code === "120")!.change, -3192);
  });
  await check("an agency missing a month is excluded, counted and named; its counts are not in the comparison", async () => {
    const two = [...CHICAGO, { ori: "ILCPD0001", year: 2024 }, { ori: "ILCPD0001", year: 2025 }];
    const seed: Seed = {
      persons: [...RETAINED.persons!, ["ILCPD0001", "13A", 2024, 50000], ["ILCPD0001", "13A", 2025, 1]],
      offenses: RETAINED.offenses, completeness: [...RETAINED.completeness!, ["ILCPD0001", 2024, 11], ["ILCPD0001", 2025, 12]],
    };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, two), ...runner(database(seed)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.deepStrictEqual(out.excluded, ["ILCPD0001"]);
    // CL4: an OBSERVED short count is stated as that count.
    assert.match(out.explanation, /Excluded from the comparison: 1 of 2 agencies for Chicago, IL \(ILCPD0001: 11 of 12 months with at least one recorded offense in 2024\)/);
    assert.strictEqual(out.rows.find((r) => r.code === "13A")!.change, 2545 - 3437);
  });
  await check("no completeness row for the prior year is not complete reporting: the comparison is declined", async () => {
    // The GC-065 fixture's own shape: a 2025 completeness row and none for 2024.
    const seed: Seed = { ...RETAINED, completeness: [["ILCPD0000", 2025, 12]] };
    const counter = { n: 0 };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(seed), counter) });
    assert.strictEqual(out.kind, "decline");
    if (out.kind !== "decline") return;
    assert.strictEqual(out.reason, "no-complete-reporter");
    // CL4: a MISSING evidence row is "cannot be confirmed", never "did not report".
    assert.match(out.explanation, /for no agency could 12 months with at least one recorded offense be confirmed in both years \(for some, the month evidence is missing rather than short\)/);
    assert.match(out.explanation, /ILCPD0000: no recorded month count for 2024, so 12 months cannot be confirmed \(this is not evidence that it failed to report\)/);
    assert.doesNotMatch(out.explanation, /did not report|didn't report|failed to report all/);
    assert.strictEqual(counter.n, 1, "only the reporting evidence was read");
  });
  await check("the increase sibling names the category that rose most", async () => {
    const out = await runOwnedCategoryChange({ plan: plan("Which violent crime saw the biggest increase in Chicago in 2025?", CHICAGO), ...runner(database(RETAINED)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.match(out.explanation, /rape \(11A\) increased the most, from 1,523 to 1,535 victims \(\+12\)/);
  });
  await check("when no compared category moved in the asked direction, none is named", async () => {
    const up: Seed = { ...RETAINED, offenses: [["ILCPD0000", "120", 2024, 10], ["ILCPD0000", "120", 2025, 20]],
      persons: [["ILCPD0000", "13A", 2024, 5], ["ILCPD0000", "13A", 2025, 9]] };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(up)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    assert.match(out.explanation, /none of the violent crime categories with records in both years decreased/);
  });
  await check("a category recorded in only one year is not compared and not treated as a change from zero", async () => {
    const one: Seed = { ...RETAINED, persons: [...RETAINED.persons!, ["ILCPD0000", "11B", 2024, 40]] };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(one)) });
    assert.ok(out.kind === "answer");
    if (out.kind !== "answer") return;
    const row = out.rows.find((r) => r.code === "11B")!;
    assert.strictEqual(row.status, "recorded in one year only");
    assert.strictEqual(row.change, null);
    assert.match(out.explanation, /Forcible Sodomy \(11B\) has records in only one of the two years\./);
    assert.match(out.explanation, /Sexual Assault With Object \(11C\) has no records in either year/);
  });

  console.log("\n-- owned-family contract --");
  await check("a refused statement executes nothing further and is declined in owned wording", async () => {
    const counter = { n: 0 };
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), ...runner(database(RETAINED), counter, (s) => /summary_victim_city_monthly/.test(s)) });
    assert.strictEqual(out.kind, "decline");
    if (out.kind !== "decline") return;
    assert.strictEqual(out.reason, "plan-refused");
    assert.strictEqual(counter.n, 1, "the refused statement and everything after it did not run");
  });
  await check("an execution failure is declined as ours, not reported as data", async () => {
    const out = await runOwnedCategoryChange({ plan: plan(GC065, CHICAGO), refusal: () => null,
      execute: async () => { throw new Error("boom"); } });
    assert.strictEqual(out.kind, "decline");
    if (out.kind === "decline") assert.strictEqual(out.reason, "execution-failed");
  });

  console.log(`\nNIBRS category change: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main();
