import { strict as assert } from "node:assert";
import { buildNibrsDomesticViolenceAggravatedAssaultShareQuery } from "../lib/nibrs-deterministic-queries.js";

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence?"
  );
  assert.ok(query, "national DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bFROM summary_victim_circumstance\b/i);
  assert.match(query.sql, /\bFROM summary_victim_state_monthly\b/i);
  assert.match(query.sql, /\bucr_offense_code = '13A'/i);
  assert.match(query.sql, /\bcircumstance_code = '06'/i);
  assert.doesNotMatch(query.sql, /\bsummary_domestic_violence\b/i);
  assert.doesNotMatch(query.sql, /\bJOIN\s+summary_victim_circumstance\b/i);
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /default last five complete calendar years/i);
  assert.equal(query.chartHint, "line");
  assert.equal(query.xAxis, "year");
  assert.equal(query.yAxis, "domestic_violence_share_pct");
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults over the past 5 years are domestic violence incidents?"
  );
  assert.ok(query, "relative-year DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults in Nebraska are domestic violence?"
  );
  assert.ok(query, "Nebraska state DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bstate IN \('NE', 'NB'\)/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence over all available years?"
  );
  assert.ok(query, "explicit all-years DV aggravated-assault share should be deterministic");
  assert.doesNotMatch(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /over all available years/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "domestic violence aggravated assault counts by race"
  );
  assert.equal(query, null, "non-share DV aggravated-assault questions should stay with normal routing");
}

console.log("nibrs deterministic query tests passed");
