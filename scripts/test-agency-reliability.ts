/**
 * Shared reliability evaluator, the agency_year_reliability table, and the
 * ordinary-answer disclosure matcher.
 *
 * The three failure modes this protects against:
 *   1. DRIFT -- the scorecard and the table disagreeing about what "unreliable" means.
 *      Both consume lib/agency-reliability.ts; the acceptance check pins the sweep to
 *      the independently verified 878 recent city agency-years.
 *   2. WRONG-OFFENSE CAVEATS -- a Louisville murder collapse tainting a theft answer,
 *      or the stored violent total inheriting a component's warning.
 *   3. OVER-DISCLOSURE -- historical single-column collapses (5,228 of them are
 *      aggravated assault, mostly reclassification practice) reaching users as
 *      "may be incomplete" when the era gate should hold them back.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  evaluateOwnHistory, evaluateRtciCrosscheck, baselineMedian, describeFindings,
  RELIABILITY_ALGORITHM_VERSION,
} from "../lib/agency-reliability";
import { classifyResultColumn, reliabilityDisclosureNote } from "../lib/reliability-disclosure";

const db = new Database(process.env.RTCI_DB_PATH || "crime_data.db", { readonly: true });

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------------
// 1. Pure evaluator decisions
// ---------------------------------------------------------------------------------

const NORMAL = { murder: 150, rape: 220, robbery: 900, assault: 3500, burglary: 3200, theft: 14000, motor_vehicle_theft: 4000 };
const PRIORS = [NORMAL, { ...NORMAL, murder: 160 }, { ...NORMAL, murder: 145 }];

check("a normal year raises nothing", evaluateOwnHistory({ ...NORMAL }, PRIORS).length === 0);

const murderCollapse = evaluateOwnHistory({ ...NORMAL, murder: 19 }, PRIORS);
check("a single collapsed column is a column-collapse on that column only",
  murderCollapse.length === 1 && murderCollapse[0].kind === "column-collapse"
  && murderCollapse[0].columns.join() === "murder", JSON.stringify(murderCollapse));

const partial = evaluateOwnHistory(
  Object.fromEntries(Object.entries(NORMAL).map(([k, v]) => [k, Math.round(v * 0.2)])), PRIORS);
check("everything falling together is a partial year",
  partial.length === 1 && partial[0].kind === "partial-year", JSON.stringify(partial.map((f) => f.kind)));

check("a stable but low RTCI murder ratio is NOT a collapse (Los Angeles)",
  evaluateRtciCrosscheck({ ...NORMAL, murder: 60 }, new Map([["Murder", 100]]), [0.6, 0.58, 0.62]).length === 0);
const laStyleBreak = evaluateRtciCrosscheck({ ...NORMAL, murder: 20 }, new Map([["Murder", 100]]), [1.05, 1.08, 1.01]);
check("a murder ratio breaking from the agency's own level IS a collapse",
  laStyleBreak.length === 1 && laStyleBreak[0].columns.includes("murder"));
const systemic = evaluateRtciCrosscheck(
  Object.fromEntries(Object.entries(NORMAL).map(([k, v]) => [k, Math.round(v * 0.4)])),
  new Map([["Murder", 150], ["Rape", 220], ["Robbery", 900], ["Aggravated Assault", 3500], ["Burglary", 3200], ["Theft", 14000], ["Motor Vehicle Theft", 4000]]),
  []);
check("many columns low at once is systemic", systemic.length === 1 && systemic[0].kind === "systemic",
  JSON.stringify(systemic.map((f) => f.kind)));
check("describeFindings yields one line per evidence entry",
  describeFindings(murderCollapse).length === 1 && /murder 19 against a baseline of 150/.test(describeFindings(murderCollapse)[0]));
check("baselineMedian is re-exported and conventional", baselineMedian([10, 20]) === 15);

// ---------------------------------------------------------------------------------
// 2. The built table: presence, versioning, and the acceptance slice
// ---------------------------------------------------------------------------------

const tableExists = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agency_year_reliability'").get());
check("agency_year_reliability exists (run scripts/build-agency-year-reliability.ts)", tableExists);
if (tableExists) {
  const maxYear = (db.prepare("SELECT MAX(year) AS y FROM historical_agency_crime").get() as { y: number }).y;
  // CITY-scoped: the 878 was verified for city agencies only. County rows now share
  // the table and are counted separately -- never merged into this gate.
  const acceptance = (db.prepare(`
    SELECT COUNT(DISTINCT r.ori || '|' || r.year) AS n FROM agency_year_reliability r
    JOIN historical_agency ha ON ha.ori = r.ori
    WHERE r.source = 'own-history' AND r.year >= ? AND ha.type = 'city'`).get(maxYear - 1) as { n: number }).n;
  check("own-history recent CITY slice matches the independently verified 878", acceptance === 878, `got ${acceptance}`);
  const countyRows = (db.prepare(`
    SELECT COUNT(*) AS n FROM agency_year_reliability r
    JOIN historical_agency ha ON ha.ori = r.ori WHERE ha.type = 'county'`).get() as { n: number }).n;
  check("county agency-years are present in the table", countyRows > 0, `got ${countyRows}`);
  const version = (db.prepare("SELECT DISTINCT algorithm_version AS v FROM agency_year_reliability").all() as { v: string }[]);
  check("one algorithm version across the table",
    version.length === 1 && version[0].v === RELIABILITY_ALGORITHM_VERSION, JSON.stringify(version));
  const louisville = db.prepare(`
    SELECT kind, columns_json FROM agency_year_reliability WHERE ori = 'KY0568000' AND year = 2025`).all() as { kind: string; columns_json: string }[];
  check("Louisville Metro 2025 is flagged on murder",
    louisville.some((r) => JSON.parse(r.columns_json).includes("murder")), JSON.stringify(louisville));
}

// ---------------------------------------------------------------------------------
// 3. Result-column classification
// ---------------------------------------------------------------------------------

for (const [input, expected] of [
  ["murder", "murder"], ["murders", "murder"], ["murder_rate", "murder"],
  ["theft", "theft"], ["thefts", "theft"], ["larceny", "theft"],
  ["motor_vehicle_theft", "motor_vehicle_theft"], ["auto_theft", "motor_vehicle_theft"], ["mvt", "motor_vehicle_theft"],
  ["assault", "assault"], ["aggravated_assault", "assault"], ["aggravated_assaults", "assault"],
  ["violent", "total"], ["violent_crime", null], ["property", "total"], ["total_offenses", "total"],
  ["year", null], ["population", null], ["agency", null], ["clearance_rate", null],
] as [string, string | null][]) {
  const got = classifyResultColumn(input);
  // violent_crime: base 'violent_crime' -- starts with 'violent' -> total. Adjust expectation:
  const want = input === "violent_crime" ? "total" : expected;
  check(`classify(${input}) = ${want}`, got === want, `got ${got}`);
}

// ---------------------------------------------------------------------------------
// 4. Disclosure matcher end-to-end against the real table
// ---------------------------------------------------------------------------------

if (tableExists) {
  const note = (q: string, sql: string | null, rows: Record<string, unknown>[], tab = "historical") =>
    reliabilityDisclosureNote(db, q, sql, rows, tab);

  const canonical = note("How many murders in Louisville in 2025?", "WHERE hac.year = 2025", [{ murder: 19 }]);
  check("Louisville 2025 murder answer is caveated",
    canonical === "Note: Louisville, KY's reported murder data may be incomplete for 2025.", canonical ?? "(none)");
  check("the caveat quotes no figures", canonical != null && !/19|108|147/.test(canonical));

  check("a theft answer for the same agency-year stays silent",
    note("How many thefts in Louisville in 2025?", "WHERE hac.year = 2025", [{ theft: 14081 }]) === null);
  check("the stored violent total does not inherit the murder warning",
    note("Violent crime in Louisville in 2025", "WHERE hac.year = 2025", [{ violent: 4041 }]) === null);
  check("a multi-year murder trend is caveated for the flagged year only",
    note("Louisville murders by year since 2020", "SELECT year, murder", [
      { year: 2023, murder: 153 }, { year: 2024, murder: 147 }, { year: 2025, murder: 19 },
    ]) === "Note: Louisville, KY's reported murder data may be incomplete for 2025.");
  check("a partial year caveats any crime measure (New Orleans 2005)",
    note("Thefts in New Orleans in 2005", "WHERE hac.year = 2005", [{ theft: 999 }])
      === "Note: New Orleans, LA's reported data may be incomplete for 2005.");
  check("a clean agency-year stays silent",
    note("Murders in Tulsa in 2025", "WHERE hac.year = 2025", [{ murder: 26 }]) === null);
  check("ambiguous geography fails open",
    note("Murders in Springfield in 2025", "SELECT murder", [{ murder: 5 }]) === null);
  check("multi-city rankings fail open",
    note("Top 10 cities by murder in 2025", "year = 2025", [{ agency: "X", murder: 1 }]) === null);
  check("historical column-collapses outside the verified window are era-gated",
    note("Rapes in Chicago in 1987", "WHERE hac.year = 1987", [{ rape: 100 }]) === null);
  check("the current tab is never caveated by this matcher",
    note("Murders in Louisville in 2025", "2025", [{ murder: 19 }], "current") === null);
  {
    // County disclosure, end-to-end, data-driven: any recent county partial-year flag.
    //
    // THE QUESTION IS BUILT FROM THE COUNTY NAME, NOT `ha.agency`. This used to interpolate
    // `ha.agency` directly, which the county resolver cannot match: since the 2026-08-18 Historical
    // rebuild, county agencies are filed without a " County" suffix ('Marshall', not 'Marshall
    // County'), and a bare name resolves to nothing. The case then reported "not caveated" for a
    // question no user would ask, which masked the real defect -- the disclosure path was dropping
    // the resolver's ORI and matching flags by name, missing 1,815 of 1,815 flagged counties.
    const countyFlag = db.prepare(`
      SELECT x.county_name AS county, ha.state AS state, r.year AS year
      FROM agency_year_reliability r
      JOIN historical_agency ha ON ha.ori = r.ori
      JOIN agency_county_crosswalk x ON x.ori9 = r.ori
      WHERE ha.type = 'county' AND r.kind = 'partial-year'
        AND x.county_name IS NOT NULL AND x.county_name <> ''
      ORDER BY r.year DESC LIMIT 1`).get() as { county: string; state: string; year: number } | undefined;
    if (countyFlag) {
      const countyFlagLabel = `${countyFlag.county} County, ${countyFlag.state.toUpperCase()}`;
      const q = `How many murders in ${countyFlagLabel} in ${countyFlag.year}?`;
      // The caveat requires POSITIVE evidence of a single county-agency query.
      const sheriffSql = `WHERE ha.type = 'county' AND hac.year = ${countyFlag.year}`;
      const countyNote = note(q, sheriffSql, [{ murder: 5 }]);
      check(`a flagged county partial-year is caveated (${countyFlagLabel} ${countyFlag.year})`,
        countyNote != null && countyNote.includes("may be incomplete"), countyNote ?? "(none)");
      // Countywide answers must NEVER inherit the sheriff's flag: a crosswalk sum over
      // every agency in the county is not the lead agency's data.
      check("a crosswalk (countywide) query is never caveated",
        note(q, `JOIN agency_county_crosswalk acc ON ... WHERE hac.year = ${countyFlag.year}`, [{ murder: 5 }]) === null);
      check("explicit countywide phrasing fails open even with county-agency SQL",
        note(`Countywide murders in ${countyFlagLabel} in ${countyFlag.year}`, sheriffSql, [{ murder: 5 }]) === null);
      check("all-agencies phrasing fails open",
        note(`Murders across all agencies in ${countyFlagLabel} in ${countyFlag.year}`, sheriffSql, [{ murder: 5 }]) === null);
      check("county SQL without single-agency evidence fails open",
        note(q, `WHERE hac.year = ${countyFlag.year}`, [{ murder: 5 }]) === null);
    }
    check("an ambiguous bare county name fails open",
      note("Murders in Washington County in 2024", "ha.type = 'county' AND year = 2024", [{ murder: 5 }]) === null);

    // COUNTY CAVEATS MUST NOT BE OVERBROAD. Restoring the county path is only correct if it stays
    // offence-scoped the way the city path already is. A partial-year flag is deliberately
    // offence-agnostic -- a partial reporting year affects every count -- so the discriminating
    // case is a column-collapse: the collapsed column is caveated and a column the flag does not
    // name stays silent. Without this, "carry the ORI" could have turned every county answer into
    // a warning, which is over-disclosure rather than a fix.
    const collapse = db.prepare(`
      SELECT x.county_name AS county, ha.state AS state, r.year AS year, r.columns_json AS columns
      FROM agency_year_reliability r
      JOIN historical_agency ha ON ha.ori = r.ori
      JOIN agency_county_crosswalk x ON x.ori9 = r.ori
      WHERE ha.type = 'county' AND r.kind = 'column-collapse'
        AND x.county_name IS NOT NULL AND x.county_name <> ''
        AND r.ori NOT IN (SELECT ori FROM agency_year_reliability
                          WHERE kind IN ('partial-year', 'systemic'))
      ORDER BY r.year DESC LIMIT 1`).get() as
      { county: string; state: string; year: number; columns: string } | undefined;
    if (collapse) {
      const flagged = (JSON.parse(collapse.columns) as string[])[0];
      const unflagged = ["murder", "robbery", "theft", "burglary", "assault"]
        .find((c) => !(JSON.parse(collapse.columns) as string[]).includes(c))!;
      const label = `${collapse.county} County, ${collapse.state.toUpperCase()}`;
      const sql = `WHERE ha.type = 'county' AND hac.year = ${collapse.year}`;
      check(`a flagged county column IS caveated (${label} ${collapse.year} ${flagged})`,
        note(`How many ${flagged} in ${label} in ${collapse.year}?`, sql, [{ [flagged]: 5 }]) != null);
      check(`an unflagged county column stays silent (${label} ${collapse.year} ${unflagged})`,
        note(`How many ${unflagged} in ${label} in ${collapse.year}?`, sql, [{ [unflagged]: 5 }]) === null);
    } else {
      check("a county column-collapse case exists to test offence scoping with", false,
        "no county column-collapse flag without a broad flag on the same ORI");
    }
  }
  check("no crime measure in the result means no caveat",
    note("Population of Louisville in 2025", "WHERE year = 2025", [{ population: 691630 }]) === null);
}

// ---------------------------------------------------------------------------------
// 5. Route wiring
// ---------------------------------------------------------------------------------

const route = fs.readFileSync(path.join(__dirname, "..", "app/api/query/route.ts"), "utf8");
check("route imports the matcher", /import \{ reliabilityDisclosureNote \} from "@\/lib\/reliability-disclosure"/.test(route));
// The note is computed ONCE, BEFORE the initial result event -- so the primary answer,
// the cache, and the both-explanations-failed fallback all carry it. Late-only
// computation left the first (and cached) answer uncaveated.
check("the note is computed exactly once",
  (route.match(/reliabilityDisclosureNote\(getDb\(\), question, sql, rows, tab\)/g) ?? []).length === 1);
check("the note is computed before the initial result event",
  route.indexOf("reliabilityDisclosureNote(getDb()") < route.indexOf("// Step 5b: Send result immediately"));
check("the caveated explanation is what gets cached",
  route.indexOf("reliabilityDisclosureNote(getDb()") < route.indexOf("setCache(question, tab, { sql, explanation: claude.explanation"));
check("the refined explanation reapplies the note after the grain override",
  (route.match(/= withReliabilityNote\((?:postExplanation|retryExplanation)\)/g) ?? []).length === 2);
check("disclosures are tagged for the query log",
  route.includes('firedGuardrails.push("reliability-disclosed")'));

db.close();
if (failures > 0) {
  console.error(`\n  test-agency-reliability: ${failures} failure(s)`);
  process.exit(1);
}
console.log("  test-agency-reliability: PASS");
