/**
 * State/national scorecards and the shared Historical dispatcher.
 *
 * The rules these tests exist to hold:
 *   - State and national cards come from historical_state_national, the FBI's own
 *     published aggregates. NEVER from summing historical_agency_crime -- agency
 *     participation varies by year, so a sum undercounts by whatever failed to report.
 *   - Aggregate cards carry no clearance column at all. The FBI publishes no
 *     state-level clearance in this series; a column of blanks would imply otherwise.
 *   - A NULL or non-positive prior-year value makes the change UNKNOWN, never 0%.
 *   - Agency cards are byte-identical in behavior to before the dispatcher existed.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildHistoricalScorecard, buildStateScorecard, buildNationalScorecard,
  detectNationalScorecardQuestion,
} from "../lib/historical-scorecard";
import { buildAgencyScorecard, type AgencyScorecardRow } from "../lib/agency-scorecard";
import ScorecardPanel from "../components/ScorecardPanel";

const db = new Database(process.env.RTCI_DB_PATH || "crime_data.db", { readonly: true });

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) return;
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

const offenseRow = (card: { rows: AgencyScorecardRow[] } | null, label: string) =>
  card?.rows.find((row) => row.offense === label);

// ---------------------------------------------------------------------------------
// 1. State builder values equal direct database calculations
// ---------------------------------------------------------------------------------

const ohio = buildStateScorecard(db, "Ohio");
check("Ohio card builds", ohio.rows.length === 9, ohio.explanation.slice(0, 120));
check("Ohio scope", ohio.scope === "state");
check("Ohio label is the official state name", ohio.agencyLabel === "Ohio");
check("Ohio omits clearance", ohio.showClearance === false);
check("Ohio rows carry no clearance values", ohio.rows.every((row) => row.clearance_rate == null));
check("Ohio column contract drops clearance for CSV export too",
  !ohio.columns.includes("clearance_rate") && ohio.columns.length === 4, ohio.columns.join(","));
check("Ohio SQL never touches agency tables",
  !/historical_agency/i.test(ohio.sql ?? ""), ohio.sql ?? "");
check("Ohio status is the latest-FBI-year line",
  ohio.statusText === `${ohio.year} · Latest FBI reporting year`, ohio.statusText);
check("Ohio yearStatus latest", ohio.yearStatus === "latest" && ohio.newerExcludedYear === null);

const direct = db.prepare(`
  SELECT year, population, murder, rape, robbery, aggravated_assault, burglary, theft, auto_theft,
         murder_rate, rape_rate, robbery_rate, aggravated_assault_rate, burglary_rate, theft_rate, auto_theft_rate
  FROM historical_state_national WHERE state = ? AND year = ?`);
const round1 = (value: number) => Math.round(value * 10) / 10;

for (const [name, card] of [["Ohio", ohio], ["United States", buildNationalScorecard(db)]] as const) {
  const row = direct.get(name, card.year) as Record<string, number>;
  const prior = direct.get(name, (card.year as number) - 1) as Record<string, number> | undefined;
  check(`${name}: a ${card.year} row exists to verify against`, Boolean(row));
  if (!row) continue;

  const violent = offenseRow(card, "Violent Crime")!;
  const property = offenseRow(card, "Property Crime")!;
  const expectedViolent = row.murder + row.rape + row.robbery + row.aggravated_assault;
  const expectedProperty = row.burglary + row.theft + row.auto_theft;
  check(`${name}: violent count is the component sum`, violent.offenses === expectedViolent,
    `card ${violent.offenses} vs direct ${expectedViolent}`);
  check(`${name}: property count is the component sum`, property.offenses === expectedProperty,
    `card ${property.offenses} vs direct ${expectedProperty}`);
  check(`${name}: violent rate is the summed official rates`,
    violent.rate_per_100k === round1(row.murder_rate + row.rape_rate + row.robbery_rate + row.aggravated_assault_rate),
    `card ${violent.rate_per_100k}`);
  check(`${name}: property rate is the summed official rates`,
    property.rate_per_100k === round1(row.burglary_rate + row.theft_rate + row.auto_theft_rate),
    `card ${property.rate_per_100k}`);

  const murder = offenseRow(card, "Murder")!;
  const mvt = offenseRow(card, "Motor Vehicle Theft")!;
  check(`${name}: murder row uses the stored count and rate`,
    murder.offenses === row.murder && murder.rate_per_100k === round1(row.murder_rate));
  check(`${name}: motor vehicle theft maps to auto_theft`,
    mvt.offenses === row.auto_theft && mvt.rate_per_100k === round1(row.auto_theft_rate));

  if (prior) {
    check(`${name}: murder change matches the direct prior-year calculation`,
      murder.offense_change_pct === round1((row.murder - prior.murder) * 100 / prior.murder),
      `card ${murder.offense_change_pct}`);
    check(`${name}: violent change compares component-sum totals`,
      violent.offense_change_pct === round1(
        (expectedViolent - (prior.murder + prior.rape + prior.robbery + prior.aggravated_assault)) * 100
        / (prior.murder + prior.rape + prior.robbery + prior.aggravated_assault)),
      `card ${violent.offense_change_pct}`);
  }
  check(`${name}: total_offenses was not substituted for a group total`,
    violent.offenses !== null && property.offenses !== null
    && violent.offenses + property.offenses === expectedViolent + expectedProperty);
}

const national = buildNationalScorecard(db);
check("national scope", national.scope === "national");
check("national label", national.agencyLabel === "United States");
check("national SQL targets the United States row",
  /state = 'United States'/.test(national.sql ?? "") && !/historical_agency/i.test(national.sql ?? ""),
  national.sql ?? "");

// ---------------------------------------------------------------------------------
// 2. Agency behavior is unchanged under the dispatcher
// ---------------------------------------------------------------------------------

const AGENCY_CANARIES: [string, number][] = [
  ["Louisville, KY", 2024], ["Los Angeles, CA", 2025], ["San Diego, CA", 2025],
  ["Toledo, OH", 2024], ["Tulsa, OK", 2025], ["Charlotte, NC", 2025],
  ["Las Vegas, NV", 2025], ["Nashville, TN", 2025],
];
for (const [place, expectedYear] of AGENCY_CANARIES) {
  const viaDispatcher = buildHistoricalScorecard(db, `${place} crime scorecard`);
  const directAgency = buildAgencyScorecard(db, `${place} crime scorecard`);
  check(`${place}: dispatcher year ${expectedYear}`, viaDispatcher?.year === expectedYear,
    `year=${viaDispatcher?.year}`);
  check(`${place}: dispatcher output identical to the agency builder`,
    JSON.stringify(viaDispatcher) === JSON.stringify(directAgency));
  check(`${place}: scope agency with clearance`,
    viaDispatcher?.scope === "agency" && viaDispatcher?.showClearance === true);
}

const louisville = buildHistoricalScorecard(db, "Louisville, KY crime scorecard");
check("Louisville murder 147", offenseRow(louisville, "Murder")?.offenses === 147);
check("Louisville carries the fallback status",
  louisville?.yearStatus === "fallback" && louisville?.newerExcludedYear === 2025
  && louisville?.statusText === "2024 · Latest reliable year · 2025 may be incomplete",
  louisville?.statusText);
const tulsa = buildHistoricalScorecard(db, "Tulsa, OK crime scorecard");
check("Tulsa carries the latest status",
  tulsa?.yearStatus === "latest" && tulsa?.statusText === "2025 · Latest reliable year",
  tulsa?.statusText);

// ---------------------------------------------------------------------------------
// 3. Scope resolution
// ---------------------------------------------------------------------------------

const scopeOf = (question: string) => {
  const card = buildHistoricalScorecard(db, question);
  return card ? `${card.scope}:${card.agencyLabel || "(clarify)"}:${card.rows.length > 0 ? "built" : "unavailable"}` : "null";
};
check('"Ohio crime scorecard" -> state', scopeOf("Ohio crime scorecard") === "state:Ohio:built");
check('"Ohio score card" -> state', scopeOf("Ohio score card") === "state:Ohio:built");
check('"OH scorecard" -> state via bare abbreviation', scopeOf("OH scorecard") === "state:Ohio:built");
check('"national crime scorecard" -> national', scopeOf("national crime scorecard") === "national:United States:built");
check('"United States scorecard" -> national', scopeOf("United States scorecard") === "national:United States:built");
check('"US crime scorecard" -> national', scopeOf("US crime scorecard") === "national:United States:built");
check('"US score card" -> national', scopeOf("US score card") === "national:United States:built");
check('"USA scorecards" -> national', scopeOf("USA scorecards") === "national:United States:built");
check('"Toledo scorecard" -> agency', scopeOf("Toledo scorecard") === "agency:Toledo, OH:built");
check('"New York State scorecard" -> state', scopeOf("New York State scorecard") === "state:New York:built");

const nycCard = buildHistoricalScorecard(db, "New York City scorecard");
check('"New York City scorecard" -> agency scope', nycCard?.scope === "agency",
  `scope=${nycCard?.scope} rows=${nycCard?.rows.length}`);

const bareNy = buildHistoricalScorecard(db, "New York scorecard");
check('bare "New York" asks which scope, not for a city',
  bareNy?.rows.length === 0 && /city or a state/i.test(bareNy?.explanation ?? ""),
  bareNy?.explanation.slice(0, 120));
const washington = buildHistoricalScorecard(db, "Washington scorecard");
check('bare "Washington" asks which scope',
  washington?.rows.length === 0 && /city or a state/i.test(washington?.explanation ?? ""),
  washington?.explanation.slice(0, 120));

check('lowercase "us" does not hijack a no-place question',
  scopeOf("give us a scorecard").startsWith("agency:") && (buildHistoricalScorecard(db, "give us a scorecard")?.rows.length === 0),
  scopeOf("give us a scorecard"));
check('lowercase "us" with a city stays the city',
  scopeOf("give us a Toledo scorecard") === "agency:Toledo, OH:built");
check("a non-scorecard question returns null", buildHistoricalScorecard(db, "murders in Ohio in 2020") === null);

check("national detector accepts U.S.", detectNationalScorecardQuestion("U.S. scorecard") === true);
check("national detector rejects lowercase us", detectNationalScorecardQuestion("give us a scorecard") === false);

// ---------------------------------------------------------------------------------
// 4. NULL / non-positive prior values are unknown, never 0%
// ---------------------------------------------------------------------------------

{
  const fixture = new Database(":memory:");
  fixture.exec(`
    CREATE TABLE historical_state_national (state TEXT, year INT, population INT,
      murder INT, rape INT, robbery INT, aggravated_assault INT, burglary INT, theft INT, auto_theft INT,
      murder_rate REAL, rape_rate REAL, robbery_rate REAL, aggravated_assault_rate REAL,
      burglary_rate REAL, theft_rate REAL, auto_theft_rate REAL);
    -- 2024: complete. 2023: murder NULL, robbery 0, theft normal.
    INSERT INTO historical_state_national VALUES
      ('Testonia', 2024, 1000000, 50, 200, 300, 1000, 2000, 8000, 900, 5, 20, 30, 100, 200, 800, 90),
      ('Testonia', 2023, 1000000, NULL, 190, 0, 950, 1900, 7500, 850, NULL, 19, 0, 95, 190, 750, 85);
  `);
  const card = buildStateScorecard(fixture, "Testonia");
  check("fixture card builds on the complete 2024 row", card.year === 2024 && card.rows.length === 9,
    card.explanation.slice(0, 100));
  check("NULL prior murder -> unknown change, not 0%",
    offenseRow(card, "Murder")?.offense_change_pct === null);
  check("zero prior robbery -> unknown change, not Infinity or 0%",
    offenseRow(card, "Robbery")?.offense_change_pct === null);
  check("violent total change is unknown when a prior component is NULL",
    offenseRow(card, "Violent Crime")?.offense_change_pct === null);
  check("theft change still computes from its valid prior",
    offenseRow(card, "Theft")?.offense_change_pct === round1((8000 - 7500) * 100 / 7500));
  check("property total change computes when all prior components are valid",
    offenseRow(card, "Property Crime")?.offense_change_pct
      === round1(((2000 + 8000 + 900) - (1900 + 7500 + 850)) * 100 / (1900 + 7500 + 850)));

  // No prior year at all: every change is unknown.
  const lone = new Database(":memory:");
  lone.exec(`
    CREATE TABLE historical_state_national (state TEXT, year INT, population INT,
      murder INT, rape INT, robbery INT, aggravated_assault INT, burglary INT, theft INT, auto_theft INT,
      murder_rate REAL, rape_rate REAL, robbery_rate REAL, aggravated_assault_rate REAL,
      burglary_rate REAL, theft_rate REAL, auto_theft_rate REAL);
    INSERT INTO historical_state_national VALUES
      ('Testonia', 2024, 1000000, 50, 200, 300, 1000, 2000, 8000, 900, 5, 20, 30, 100, 200, 800, 90);
  `);
  const loneCard = buildStateScorecard(lone, "Testonia");
  check("missing prior year -> every change unknown",
    loneCard.rows.every((row) => row.offense_change_pct === null));
  fixture.close();
  lone.close();
}

// ---------------------------------------------------------------------------------
// 5. Rendering: status line, hierarchy, arrows, clearance omission, mobile classes
// ---------------------------------------------------------------------------------

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(ScorecardPanel as never, props as never));

const sampleRows: AgencyScorecardRow[] = [
  { offense: "Violent Crime", offenses: 4788, rate_per_100k: 707.4, clearance_rate: 42.6, offense_change_pct: -6.6, section: true },
  { offense: "Murder", offenses: 147, rate_per_100k: 21.7, clearance_rate: 162.5, offense_change_pct: 3.9 },
  { offense: "Rape", offenses: 208, rate_per_100k: 30.7, clearance_rate: 21.1, offense_change_pct: 0 },
  { offense: "Property Crime", offenses: 22513, rate_per_100k: 3326.4, clearance_rate: 9.3, offense_change_pct: null, section: true },
];

const agencyHtml = render({
  agencyLabel: "Louisville, KY", year: 2024, rows: sampleRows, explanation: "x",
  statusText: "2024 · Latest reliable year · 2025 may be incomplete", showClearance: true,
});
check("status line renders under the title",
  agencyHtml.includes("2024 · Latest reliable year · 2025 may be incomplete"));
check("decrease renders the down arrow with an accessible label",
  agencyHtml.includes("▼") && agencyHtml.includes('aria-label="decreased from prior year"'));
check("increase renders the up arrow with an accessible label",
  agencyHtml.includes("▲") && agencyHtml.includes('aria-label="increased from prior year"'));
check("zero change renders a neutral 0.0% without an arrow",
  agencyHtml.includes("0.0%") && !agencyHtml.includes('aria-label="increased from prior year">▲</span>0.0%'));
check("unknown change renders a labelled dash, never 0.0%",
  agencyHtml.includes('aria-label="change versus prior year unknown"'));
check("section totals are semibold", /font-semibold[^>]*>Violent Crime/.test(agencyHtml.replace(/"[^"]*"/g, (m) => m)) || agencyHtml.includes("font-semibold"));
check("component rows are indented under their section",
  /pl-6[^"]*"[^>]*>Murder/.test(agencyHtml) || /pl-6 sm:pr-4 sm:pl-8[^"]*"/.test(agencyHtml));
check("label column is sticky for narrow-screen scrolling", agencyHtml.includes("sticky left-0"));
check("horizontal scroll container is preserved", agencyHtml.includes("overflow-x-auto"));
check("tabular numerals are preserved", agencyHtml.includes("tabular-nums"));
check("agency card renders the clearance header", agencyHtml.includes("Clearance Rate"));
check("agency card renders the over-100% footnote", agencyHtml.includes("Clearance rates can exceed 100%"));

const aggregateRows = sampleRows.map((row) => ({ ...row, clearance_rate: null }));
const stateHtml = render({
  agencyLabel: "Ohio", year: 2024, rows: aggregateRows, explanation: "x",
  statusText: "2024 · Latest FBI reporting year", showClearance: false,
});
check("aggregate card has no clearance header at all", !stateHtml.includes("Clearance Rate"));
check("aggregate card has no clearance footnote", !stateHtml.includes("Clearance rates can exceed"));
check("aggregate card keeps the FBI status line", stateHtml.includes("2024 · Latest FBI reporting year"));
check("aggregate heading uses the state label", stateHtml.includes("Ohio Crime Scorecard (2024)"));

db.close();
if (failures > 0) {
  console.error(`\n  test-historical-scorecard: ${failures} failure(s)`);
  process.exit(1);
}
console.log("  test-historical-scorecard: PASS");
