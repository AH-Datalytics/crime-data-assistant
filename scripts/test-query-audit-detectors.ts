import assert from "node:assert/strict";
import { detectQueryAuditFindings, QUERY_AUDIT_DETECTORS, type QueryAuditRow } from "../lib/query-audit-detectors";

// This is the SQL captured in production query_log 7845, retained verbatim as a regression fixture.
const loggedRollingSql = `WITH rolling AS (
  SELECT year, month,
    SUM(count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS rolling_12
  FROM national_monthly
  WHERE offense IN ('Murder','Rape','Robbery','Aggravated Assault')
)
SELECT year, month, rolling_12 FROM rolling WHERE year >= 2018`;

const rows: QueryAuditRow[] = [
  { id: 7881, question: "How many police fatal shootings occurred from 2020 to 2023?", sql: "SELECT year, SUM(count) FROM incidents WHERE homicide_type='Murder' GROUP BY year", response: "Fatal shootings from 2020 to 2023.", rows: 4, query_contract: "geography=national; metric=shootings; period=2020-2023" },
  { id: 7772, question: "Carjacking incidents in Baltimore City", sql: "SELECT year, count FROM agency_monthly WHERE ori='MD0030100'", response: "Carjacking incidents in cities in the dataset City.", rows: 5 },
  { id: 7773, question: "Carjackings in Baltimore City by month", sql: "SELECT year, month, count FROM agency_monthly WHERE ori='MD0030100'", response: "Carjackings in cities in the dataset City by month.", rows: 5 },
  { id: 7845, question: "How have violent crimes trended over time?", sql: loggedRollingSql, response: "This is a 12-month rolling trend of violent crime.", rows: 20 },
  { id: 2305, question: "What are violent crime trends?", sql: "WITH x AS (SELECT year, month, SUM(count) OVER (ORDER BY year,month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) rolling FROM national_monthly WHERE offense IN ('Murder','Rape','Robbery')) SELECT * FROM x", response: "Violent crime trends by month.", rows: 20 },
  { id: 1413, question: "What is the murder rate?", sql: "SELECT year, SUM(am.count) * 100000.0 / SUM(ap.population) rate FROM agency_monthly am JOIN agency_population ap ON ap.ori=am.ori GROUP BY year", response: "Murder rate per 100,000.", rows: 4 },
  { id: 7780, question: "Murder victim race in Houston since 2010", sql: "SELECT year, AsianPacific_Islander FROM shr GROUP BY year", response: "Comparison includes: White, Black, Asianpacific Islander, American Indian.", rows: 4, canonicalValues: ["Asian/Pacific Islander", "White", "Black", "American Indian"] },
  { id: 7855, question: "Murders in Baltimore from 2020 to 2023", sql: null, response: "I couldn't build a reliable query that matched the request.", rows: 0, query_contract: "geography=Baltimore; metric=murders; period=2020-2023" },
  { id: 7900, question: "Burglary in Chicago in 2022", sql: null, response: "I couldn't build a reliable query that matched the request.", rows: 0, query_contract: "geography=Chicago; metric=burglary; period=2022" },
  { id: 2031, question: "Murder rate by state", sql: "SELECT state, year, SUM(ap.population) population, SUM(count) * 100000.0 / SUM(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY state, year", response: "Murder rate per 100,000.", rows: 50 },
  { id: 1939, question: "Violent crime rate in Rochester", sql: "SELECT year, month, SUM(count) / SUM(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY year, month", response: "Violent crime rate per 100,000.", rows: 20 },
  { id: 5524, question: "Murder rate in Chicago", sql: "SELECT year, SUM(count) * 100000.0 / SUM(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY year", response: "Murder rate per 100,000.", rows: 5 },
  { id: 7463, question: "Murder rates by state", sql: "SELECT state, year, SUM(count) / MAX(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY state, year", response: "Murder rate per 100,000.", rows: 50 },
  { id: 2849, question: "Murder rate in Kansas City", sql: "SELECT year, SUM(count) / SUM(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY year", response: "Murder rate per 100,000.", rows: 5 },
  { id: 2822, question: "Murder rates in Kansas City and Boston", sql: "SELECT year, SUM(count) / SUM(ap.population) rate FROM agency_monthly JOIN agency_population ap USING(ori) GROUP BY year", response: "Murder rate per 100,000.", rows: 5 },
  { id: 7518, question: "Murder rates by state", sql: "SELECT state, year, SUM(population) population, SUM(count) / SUM(population) rate FROM sample_agency_year GROUP BY state, year", response: "Murder rate per 100,000.", rows: 50 },
  { id: 9000, question: "Murder in Chicago in 2022", sql: "SELECT year, count FROM agency_monthly WHERE ori='IL001'", response: "Murder in Chicago in 2022.", rows: 1, guardrails: "contract-year-lower-bound-missing" },
  { id: 9100, question: "Murder trend from 2015 to 2025", sql: "SELECT year, count FROM agency_monthly WHERE year >= 2017 AND year <= 2024", response: "Murder trend, 2015–2025.", rows: 8 },
  { id: 2000, question: "Fatal shootings by year", sql: "SELECT year, COUNT(*) FROM incidents WHERE homicide_type='Murder' GROUP BY year", response: "Fatal shootings by year.", rows: 4 },
  { id: 7920, question: "Fatal shootings by year", sql: "SELECT year, COUNT(*) FROM incidents WHERE homicide_type='Murder' GROUP BY year", response: "Fatal shootings by year.", rows: 4 },
  { id: 7915, question: "Violent crime in Chicago", sql: "SELECT year, COUNT(*) FROM incidents WHERE city='Chicago' GROUP BY year", response: "Violent crime in Chicago.", rows: 4 },
  { id: 3736, question: "Murder rate by month", sql: "SELECT year, month, SUM(count) / MAX(population) rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 3234, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 2591, question: "Rolling murder rate", sql: "SELECT year, month, SUM(count) OVER (ORDER BY year,month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) / MAX(population) rate FROM national_monthly GROUP BY year, month", response: "Rolling murder rate.", rows: 20 },
  { id: 2872, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 3133, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 1934, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 1935, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 1936, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 1937, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 2533, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 2534, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
  { id: 2535, question: "Murder rate by month", sql: "SELECT year, month, count / population rate FROM national_monthly GROUP BY year, month", response: "Murder rate by month.", rows: 20 },
];

const allResults = rows.map((row) => ({ id: row.id!, row, findings: detectQueryAuditFindings(row) }));
const ids = (id: number) => allResults.find((item) => item.id === id)?.findings.map((item) => item.detectorId) || [];
assert.ok(ids(7881).includes("D1"));
assert.ok(ids(7772).includes("D2"));
assert.ok(ids(7773).includes("D2"));
assert.ok(ids(7845).includes("D3"));
assert.ok(ids(2305).includes("D3"));
assert.ok(ids(1413).includes("D5"));
assert.ok(ids(7780).includes("D6"));
assert.ok(ids(7855).includes("D7"));
assert.ok(ids(7900).includes("D7"));
assert.ok(ids(2031).includes("D5"));
assert.ok(ids(9000).includes("D8"));
assert.ok(ids(9100).includes("D4"));
for (const id of [3736, 3234, 2591, 2872, 3133, 1934, 1935, 1936, 1937, 2533, 2534, 2535]) assert.ok(!ids(id).includes("D5"));
assert.ok(ids(7920).every((id) => id !== "D1" && id !== "D2" && id !== "D3" && id !== "D7"));
assert.ok(ids(7915).every((id) => id !== "D1" && id !== "D2" && id !== "D3" && id !== "D7"));
assert.equal(ids(7780).filter((id) => id === "D6").length, 1);
assert.ok(allResults.find((item) => item.id === 7845)?.row.sql?.includes("ROWS BETWEEN 11 PRECEDING"));
assert.ok(QUERY_AUDIT_DETECTORS.every((detector) => typeof detector.detect === "function" && detector.proposedFix.length > 0));

const corpusRows = rows.filter((row) => ![2000, 9000, 9100].includes(row.id || 0));
assert.equal(corpusRows.length, 30);
const calibration = QUERY_AUDIT_DETECTORS.map((detector) => {
  const flagged = corpusRows.filter((row) => detectQueryAuditFindings(row).some((item) => item.detectorId === detector.id)).length;
  return { detector: detector.id, flagged, unflagged: corpusRows.length - flagged, status: "uncalibrated" };
});
console.table(calibration);
console.log(`query audit detector tests passed (${corpusRows.length} enumerated corpus rows; assertions completed before this log)`);
