process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test-key";
const assert = require("node:assert/strict");
const {
  analyze,
  buildHumanEmail,
  buildHumanIncidents,
  contractCityCount,
  contractLooksAnswerable,
  recordReliabilityTag,
  isHumanQuery,
} = require("./daily-query-analysis.js");

function stats() {
  return {
    guardrailFires: {},
    resolverTags: {},
    reliabilityCategories: {
      signal: {
        tag: "contract-year-lower-bound-missing",
        threshold: 3,
        count: 0,
        examples: [],
        resolvedCount: 0,
        resolvedExamples: [],
      },
    },
  };
}

const unresolved = stats();
recordReliabilityTag(unresolved, "contract-year-lower-bound-missing", "missing bound");
assert.equal(unresolved.reliabilityCategories.signal.count, 1);
assert.equal(unresolved.reliabilityCategories.signal.resolvedCount, 0);

const resolved = stats();
recordReliabilityTag(resolved, "contract-year-lower-bound-missing-resolved-on-retry", "fixed on retry");
assert.equal(resolved.reliabilityCategories.signal.count, 0);
assert.equal(resolved.reliabilityCategories.signal.resolvedCount, 1);
assert.equal(resolved.guardrailFires["contract-year-lower-bound-missing-resolved-on-retry"], 1);

const cities = [
  "Chicago", "New York City", "Houston", "Philadelphia", "Los Angeles", "Memphis", "Detroit", "Milwaukee",
  "St Louis", "Dallas", "Indianapolis", "Baltimore", "Kansas City", "Phoenix", "Washington", "San Antonio",
  "Cleveland", "Atlanta", "Charlotte", "Las Vegas", "Columbus", "Birmingham", "Jacksonville", "Fort Worth",
  "Albuquerque", "Oklahoma City", "Cincinnati", "Minneapolis", "Nashville", "Richmond", "Austin", "Portland",
];
const cityContract = JSON.stringify({
  geography: { kind: "city", name: "Chicago" },
  geographies: cities.map((name) => ({ kind: "city", name })),
  metric: { topic: "murder", offenseCodes: ["09A"] },
  time: { startYear: 2025, endYear: 2025 },
});
assert.equal(contractLooksAnswerable({ query_contract: cityContract, question: "murders in 2025" }), true);
assert.equal(contractCityCount({ query_contract: cityContract }), 32);

const reviewQueries = [
  {
    id: 8348, ts: 1, tab: "historical", session_id: "clearance-session",
    question: "murders and clearance rate in 2025", sql: null, rows: 0, error: null, ms: 10,
    response: "Historical clearance data currently end in 2024. Ask for 2024 or earlier.",
    guardrails: "historical-year-unavailable", query_contract: cityContract,
  },
  {
    id: 8375, ts: 2, tab: "nibrs", session_id: "clearance-session",
    question: `give me murders and murder clearances by type for 2025 for these cities: ${cities.join(", ")}`,
    sql: null, rows: 0, error: null, ms: 20,
    response: "I could not generate a database query for that request.",
    guardrails: "no-sql-server-template", query_contract: cityContract,
  },
  {
    id: 8376, ts: 3, tab: "nibrs", session_id: "clearance-session",
    question: "just clearances by type",
    sql: "SELECT city, cleared_by_arrest FROM summary_clearance_detail JOIN agencies USING (ori)",
    rows: 68, error: null, ms: 30, response: "Clearances by type for the requested cities.",
    guardrails: "nibrs-query-plan", query_contract: "",
  },
  {
    id: 8378, ts: 4, tab: "historical", session_id: "comparison-session",
    question: "compare tulsa and oklahoma city homicides over time",
    sql: "SELECT year FROM historical_agency_crime", rows: 0,
    error: "DB retry failed: no such column: max_yr", ms: 40, response: null,
    guardrails: "schema-column-invalid", query_contract: "",
  },
  {
    id: 8379, ts: 5, tab: "current", session_id: "healthy-session",
    question: "robbery in Chicago in 2024", sql: "SELECT year, count FROM agency_monthly",
    rows: 12, error: null, ms: 50, response: "Monthly robbery counts for Chicago in 2024.",
    guardrails: null, query_contract: "",
  },
];

const review = analyze(reviewQueries);
assert.ok(review.issues.some((issue) => issue.id === 8348 && issue.type === "missing_source_alternative"));
assert.ok(review.issues.some((issue) => issue.id === 8375 && issue.type === "answerable_no_sql"));
assert.ok(review.issues.some((issue) => issue.id === 8376 && issue.type === "place_multiplicity"));
assert.ok(review.issues.some((issue) => issue.id === 8378 && issue.type === "error"));

const incidents = buildHumanIncidents(reviewQueries, review.issues);
assert.equal(incidents.length, 2, "related failures should be grouped into user-session incidents");
assert.deepEqual(incidents[0].ids, [8348, 8375, 8376]);
assert.equal(incidents[0].title, "Multi-city clearance request failed repeatedly");
assert.equal(incidents[1].title, "Historical city comparison failed");

const email = buildHumanEmail(review.stats, incidents, reviewQueries, { pageviews: 7, uniqueSessions: 3 });
assert.match(email, /Daily Answer Review/);
assert.match(email, /What the user wanted/);
assert.match(email, /What happened/);
assert.match(email, /User impact/);
assert.match(email, /Next step/);
assert.match(email, /Queries: 8348, 8375, 8376/);
assert.match(email, /1 with no problem detected/);
assert.doesNotMatch(email, /\bD[1-8]\b|Guardrails|resolved-ori|detector only/i);
assert.match(email, /Question - SQL - answer alignment/);
assert.match(email, /No mismatch detected by current checks/);
assert.match(email, /SQL sent to the database/);
assert.match(email, /SELECT year, count FROM agency_monthly/);
assert.match(email, /Monthly robbery counts for Chicago/);
assert.match(email, /<strong>Chart:<\/strong> No chart was produced\./);

const chartEmail = buildHumanEmail(review.stats, [], [{
  ...reviewQueries[reviewQueries.length - 1],
  chartAudit: { status: "incorrect", summary: "Expected Not cleared (9), but the rendered chart showed zero." },
}], null);
assert.match(chartEmail, /<strong>Chart problem:<\/strong> Expected Not cleared \(9\), but the rendered chart showed zero\./);
assert.equal(isHumanQuery({ session_id: "live-replay-2026-08-09-R01" }), false);
assert.equal(isHumanQuery({ session_id: "ordinary-user-session" }), true);

const limitationQuery = {
  id: 8303, ts: 6, tab: "shr", session_id: "real-user-session",
  question: "How many non-fatal shootings has Aurora, Colorado has in 2026?",
  sql: "", rows: 0, error: "nonfatal_shooting_refusal", ms: 5,
  response: "This database does not track nonfatal shootings. The SHR only covers fatal outcomes. I can show you fatal shootings.",
  guardrails: null, query_contract: "",
};
const limitationReview = analyze([limitationQuery]);
assert.equal(limitationReview.stats.errors, 0);
assert.ok(!limitationReview.issues.some((issue) => issue.id === 8303));
const limitationIncidents = buildHumanIncidents([limitationQuery], limitationReview.issues);
assert.equal(limitationIncidents.length, 0);
const limitationEmail = buildHumanEmail(limitationReview.stats, limitationIncidents, [limitationQuery], null);
assert.match(limitationEmail, /Supported data limitation explained correctly/);
assert.doesNotMatch(limitationEmail, /Failed before alignment could be established/);
// The tag must lead the guardrail list and the outcome must be "deterministic", which is what the
// daily analysis reads. The list carries the specific limitation's reason after the tag, so match
// the binding rather than one exact rendering of it.
const shrRouteSource = require("node:fs").readFileSync("app/api/shr-query/route.ts", "utf8");
assert.match(shrRouteSource, /\["nonfatal-shooting-capability-limit"(?:,[^\]]*)?\],\s*"deterministic"/);
console.log("daily reliability tag tests passed");
