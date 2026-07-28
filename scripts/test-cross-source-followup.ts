// Tests for lib/cross-source-followup.ts — reconstruction of follow-up context
// when the conversation switches data sources (MS01: history normalization
// drops cross-source turns, so the target route saw a bare fragment).
// Run: npx tsx scripts/test-cross-source-followup.ts
import assert from "node:assert/strict";
import { buildCrossSourceFollowupTransform, extractPriorQueryState } from "../lib/cross-source-followup";

// MS01's exact shape: three Historical turns (last one rates for Houston+Dallas),
// then a firearm follow-up that the client reroutes to SHR.
const ms01RatesSql =
  "WITH agency_houston AS (SELECT ha.ori FROM historical_agency ha JOIN historical_agency_crime hac ON hac.ori = ha.ori WHERE ha.agency = 'Houston' AND ha.state = 'tx' AND ha.type = 'city' GROUP BY ha.ori ORDER BY COUNT(*) DESC LIMIT 1), agency_dallas AS (SELECT ha.ori FROM historical_agency ha WHERE ha.agency = 'Dallas' AND ha.state = 'tx' AND ha.type = 'city'), years AS (SELECT 2010 AS year UNION ALL SELECT year + 1 FROM years WHERE year < 2025) SELECT y.year, ROUND(h.murder * 100000.0 / hp.population, 1) AS houston, ROUND(d.murder * 100000.0 / dp.population, 1) AS dallas FROM years y LIMIT 5000";

const ms01History = [
  { role: "user", content: "murders in Houston since 2010", source: "historical" },
  { role: "assistant", content: "Annual murder counts for Houston, Texas since 2010.\n[SQL: SELECT year, murder FROM historical_agency_crime WHERE year >= 2010]", source: "historical" },
  { role: "user", content: "compare to Dallas", source: "historical" },
  { role: "assistant", content: "Houston and Dallas murders.\n[SQL: SELECT year, murder FROM historical_agency_crime hac2 WHERE year >= 2010]", source: "historical" },
  { role: "user", content: "show rates instead of counts", source: "historical" },
  { role: "assistant", content: `Murder rates per 100,000 for Houston and Dallas.\n[SQL: ${ms01RatesSql}]`, source: "historical" },
];

// State extraction: last SQL wins, base question is the last NON-fragment user turn
{
  const state = extractPriorQueryState(ms01History, "shr");
  assert.ok(state, "state must be extracted from cross-source history");
  assert.equal(state!.sourceOfSql, "historical");
  assert.equal(state!.baseQuestion, "murders in Houston since 2010");
  assert.ok(state!.geos.some((g) => /houston/i.test(g)), `geos must include Houston, got ${state!.geos.join(",")}`);
  assert.ok(state!.geos.some((g) => /dallas/i.test(g)), `geos must include Dallas, got ${state!.geos.join(",")}`);
  assert.equal(state!.isPerCapita, true, "rates SQL must be detected as per-capita");
  assert.equal(state!.timeRange.start, 2010);
}

// The MS01 failing turn: transform must fire and carry the reconstructed context
{
  const t = buildCrossSourceFollowupTransform("now show firearm murders instead", ms01History, "shr");
  assert.ok(t, "cross-source transform must fire for the MS01 turn");
  assert.equal(t!.name, "carry_cross_source_context");
  assert.match(t!.contextQuestion || "", /Houston/);
  assert.match(t!.contextQuestion || "", /Dallas/);
  assert.match(t!.contextQuestion || "", /2010/);
  assert.match(t!.instruction, /Houston/);
  assert.match(t!.instruction, /Dallas/);
  assert.match(t!.instruction, /rate/i);
  assert.match(t!.instruction, /raw counts/i, "must allow count fallback when target source lacks a rate denominator");
  assert.doesNotMatch(t!.instruction, /\[SQL:/, "SQL text must never cross the source boundary");
  assert.doesNotMatch(t!.contextQuestion || "", /historical_agency/i, "table names must never cross the source boundary");
}

// Same-source history (nothing was dropped) → null; legacy transforms own it
{
  const sameSource = ms01History.map((m) => ({ ...m, source: "shr" }));
  assert.equal(buildCrossSourceFollowupTransform("now show firearm murders instead", sameSource, "shr"), null);
}

// No prior SQL anywhere → null
{
  const noSql = [
    { role: "user", content: "hi", source: "historical" },
    { role: "assistant", content: "Hello!", source: "historical" },
  ];
  assert.equal(buildCrossSourceFollowupTransform("now show firearm murders instead", noSql, "shr"), null);
}

// A fresh standalone question → null even with cross-source history
{
  assert.equal(buildCrossSourceFollowupTransform("hate crimes in Texas since 2015", ms01History, "hate_crime"), null);
}

// Malformed history entries are ignored safely
{
  assert.equal(buildCrossSourceFollowupTransform("now show firearm murders instead", [null, 42, { role: "assistant" }], "shr"), null);
}

console.log("cross-source follow-up tests passed");
