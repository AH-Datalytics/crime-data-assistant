/**
 * Guards the two reliability checks that decide WHICH YEAR a scorecard reports.
 *
 * Both exist because the FBI file itself can be wrong -- not stale, wrong. Louisville
 * submitted 19 murders for 2025 against about 150 in each recent year, and no upstream
 * refresh will ever correct it. So the builder cannot simply trust the newest complete
 * year; it has to test it.
 *
 *   1. Against RTCI's monthly submissions -- a second count of the same seven offences,
 *      available for the ~700 agencies RTCI carries.
 *   2. Against the agency's OWN prior-3-year median -- available for every agency, and
 *      the only check that can see Augusta or Chicago.
 *
 * The failure mode this test mostly protects against is OVER-refusal. An earlier flat
 * 60% rule threw away Baton Rouge 2023, a perfectly good year, because one column sat
 * at 54%. Most assertions below therefore pin years that MUST still be published.
 */
import Database from "better-sqlite3";
import { buildAgencyScorecard, baselineMedian } from "../lib/agency-scorecard";

const db = new Database(process.env.RTCI_DB_PATH || "crime_data.db", { readonly: true });

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

function card(place: string) {
  return buildAgencyScorecard(db, `${place} crime scorecard`);
}
function offense(place: string, label: string): number | null | undefined {
  return card(place)?.rows.find((row) => row.offense === label)?.offenses;
}

// --- Years that must NOT be published, with the value that gave them away ----------

// Louisville 2025: murder 19 against ~150 historically, and 108 in RTCI's monthly file.
const louisville = card("Louisville, KY");
check("Louisville avoids 2025", louisville?.year !== 2025, `year=${louisville?.year}`);
check("Louisville reports a plausible murder count",
  (offense("Louisville, KY", "Murder") ?? 0) > 100, `murder=${offense("Louisville, KY", "Murder")}`);

// Augusta 2025 is roughly a quarter of a normal year, and Augusta is NOT in RTCI --
// only the own-history check can see this one.
const augusta = card("Augusta, GA");
check("Augusta avoids the partial 2025", augusta?.year !== 2025, `year=${augusta?.year}`);
check("Augusta reports a full-year violent total",
  (offense("Augusta, GA", "Violent Crime") ?? 0) > 700, `violent=${offense("Augusta, GA", "Violent Crime")}`);

// Chicago 2025 reports aggravated assault around 2,500 against a baseline near 15,800.
const chicago = card("Chicago, IL");
check("Chicago avoids 2025", chicago?.year !== 2025, `year=${chicago?.year}`);
check("Chicago reports a plausible assault total",
  (offense("Chicago, IL", "Aggravated Assault") ?? 0) > 10000, `assault=${offense("Chicago, IL", "Aggravated Assault")}`);

// --- Years that MUST still be published (over-refusal guard) ----------------------

// Baton Rouge 2024 is genuinely broken (all seven columns at 16-35% of RTCI), but 2023
// is fine apart from robbery at 54%. A per-column rule wrongly rejected 2023.
const batonRouge = card("Baton Rouge, LA");
check("Baton Rouge publishes 2023 rather than refusing", batonRouge?.rows.length === 9,
  `rows=${batonRouge?.rows.length}: ${batonRouge?.explanation.slice(0, 100)}`);
check("Baton Rouge lands on 2023", batonRouge?.year === 2023, `year=${batonRouge?.year}`);

// Agencies with sound recent data must be untouched by either check.
for (const [place, expected] of [
  ["Tulsa, OK", 2025], ["Charlotte, NC", 2025], ["Las Vegas, NV", 2025], ["Nashville, TN", 2025],
] as [string, number][]) {
  const result = card(place);
  check(`${place} still reports ${expected}`, result?.year === expected, `year=${result?.year}`);
  check(`${place} still returns a full card`, result?.rows.length === 9, `rows=${result?.rows.length}`);
}

// --- Disclosure wording -----------------------------------------------------------

// When a year is skipped the card says so, vaguely and without quoting figures: naming
// an agency's own submission as wrong is not a claim to make in passing.
check("a fallback card discloses that the newer year may be incomplete",
  louisville?.explanation.includes("may be incomplete") === true, louisville?.explanation.slice(0, 120));
for (const banned of ["19", "108", "disagree", "monthly"]) {
  check(`fallback wording omits "${banned}"`,
    !(louisville?.explanation ?? "").includes(banned), louisville?.explanation.slice(0, 140));
}
// State is abbreviated in prose, matching the heading.
check("prose uses the abbreviated state", louisville?.explanation.startsWith("Louisville, KY") === true,
  louisville?.explanation.slice(0, 60));

// --- Stable cross-source disagreement is NOT an error (Codex review, 2026-08-06) -------

// Los Angeles and San Diego count murder differently from their own monthly submissions,
// stably, for years -- LA sits at 0.57-0.66 across 2021-2025. An absolute "any murder
// ratio below 60% is wrong" rule rejected their newest year every time and walked the
// card back to 2023/2024 for no reason. Only a departure from the agency's OWN level of
// agreement is evidence, which is what separates these from Louisville (about 1.05 for
// four straight years, then 0.18).
for (const place of ["Los Angeles, CA", "San Diego, CA"]) {
  const result = card(place);
  check(`${place} keeps its newest year despite a persistent murder gap`,
    result?.year === 2025, `year=${result?.year}`);
  check(`${place} returns a full card`, result?.rows.length === 9, `rows=${result?.rows.length}`);
}

// --- Conventional median, including the two-observation case --------------------------

// Taking the upper of the two middle values biases every even-length baseline upward,
// making the current year look worse than it is. With a three-year lookback an even
// count is the common case, not an edge case.
check("median of two values is their average, not the higher one", baselineMedian([10, 20]) === 15,
  `got ${baselineMedian([10, 20])}`);
check("median of two unordered values is still their average", baselineMedian([20, 10]) === 15,
  `got ${baselineMedian([20, 10])}`);
check("median of an odd count is the middle value", baselineMedian([10, 20, 300]) === 20,
  `got ${baselineMedian([10, 20, 300])}`);
check("median of four values averages the middle two", baselineMedian([10, 20, 30, 40]) === 25,
  `got ${baselineMedian([10, 20, 30, 40])}`);
check("nulls are excluded before the median is taken", baselineMedian([null, 10, null, 20]) === 15,
  `got ${baselineMedian([null, 10, null, 20])}`);
check("no observations yields no baseline", baselineMedian([null, null]) === null);

// --- A baseline needs two observations OF THE SAME OFFENCE ---------------------------

// Counting prior ROWS let a column with one non-NULL prior value form a "baseline" off
// that single number. NULL columns are common in this file, so three prior rows routinely
// means one usable observation for some offences. This fixture has full history for six
// offences and exactly ONE prior theft value; theft then collapses in the newest year.
// Under the row-count rule that single value became the baseline and 2025 was rejected.
{
  const fixture = new Database(":memory:");
  fixture.exec(`
    CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT);
    CREATE TABLE historical_agency_crime (ori TEXT, year INT, population INT, violent INT,
      murder INT, rape INT, robbery INT, assault INT, property INT, burglary INT, theft INT,
      motor_vehicle_theft INT);
    CREATE TABLE historical_agency_clearance (ori TEXT, year INT, violent_clr REAL,
      murder_clr REAL, rape_clr REAL, robbery_clr REAL, assault_clr REAL, property_clr REAL,
      burglary_clr REAL, theft_clr REAL, motor_vehicle_theft_clr REAL);
    CREATE TABLE historical_agency_population (ori TEXT, year INT, population INT);
    INSERT INTO historical_agency VALUES ('FIX00001', 'Tulsa', 'ok', 'city');
  `);
  const crime = fixture.prepare(`INSERT INTO historical_agency_crime VALUES ('FIX00001', ?, 400000, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const clr = fixture.prepare(`INSERT INTO historical_agency_clearance VALUES ('FIX00001', ?, 40, 80, 30, 30, 45, 20, 15, 20, 15)`);
  const pop = fixture.prepare(`INSERT INTO historical_agency_population VALUES ('FIX00001', ?, 400000)`);
  //           year  violent murder rape robbery assault property burglary theft  mvt
  const rowsIn: [number, number, number, number, number, number, number, number, number | null, number][] = [
    [2022, 3400, 60, 400, 350, 2590, 14000, 2500, null, 1600],
    [2023, 3400, 60, 400, 350, 2590, 14000, 2500, null, 1600],
    [2024, 3400, 60, 400, 350, 2590, 14000, 2500, 9000, 1600],
    // Newest year: every other offence steady, theft collapses to 100 against its single
    // prior observation of 9,000.
    [2025, 3400, 60, 400, 350, 2590, 14000, 2500, 100, 1600],
  ];
  for (const r of rowsIn) { crime.run(...r); clr.run(r[0]); pop.run(r[0]); }

  const fixtureCard = buildAgencyScorecard(fixture, "Tulsa, OK crime scorecard");
  check("one prior observation does not form a baseline (2025 is not rejected)",
    fixtureCard?.year === 2025,
    `year=${fixtureCard?.year} -- ${fixtureCard?.explanation.slice(0, 120)}`);
  check("the fixture card is complete", fixtureCard?.rows.length === 9, `rows=${fixtureCard?.rows.length}`);
  fixture.close();
}

db.close();
if (failures > 0) {
  console.error(`\n  test-scorecard-reliability: ${failures} failure(s)`);
  process.exit(1);
}
console.log("  test-scorecard-reliability: PASS");
