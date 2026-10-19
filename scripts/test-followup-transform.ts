import assert from "node:assert/strict";
import { detectFollowupTransform } from "../lib/followup-transform";
import type { PromptHistoryMessage } from "../lib/chat-history";

const historyWithSql: PromptHistoryMessage[] = [
  { role: "user", content: "show rolling 12 month murders in Kansas City" },
  {
    role: "assistant",
    content:
      "SELECT year, month, SUM(count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS murders FROM agency_monthly",
  },
];

const domesticViolenceRateHistory: PromptHistoryMessage[] = [
  { role: "user", content: "rates of domestic violence across jurisdictions in 2025" },
  {
    role: "assistant",
    content:
      "SELECT dv.state, dv.dv_incidents, ROUND(dv.dv_incidents * 100000.0 / pop.reporting_population, 1) AS rate_per_100k FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori",
  },
];

const currentMonthlyTrendHistory: PromptHistoryMessage[] = [
  { role: "user", content: "monthly murders in Houston since 2021" },
  {
    role: "assistant",
    content:
      "SELECT am.year, am.month, am.count FROM agency_monthly am WHERE am.agency = 'Houston' AND am.state = 'TX' AND am.type = 'City' AND am.offense = 'Murder' AND am.year >= 2021 ORDER BY am.year, am.month",
  },
];

const comparisonTrendHistory: PromptHistoryMessage[] = [
  { role: "user", content: "Compare Atlanta and Dallas murders since 2020" },
  {
    role: "assistant",
    content:
      "SELECT am.agency, am.year, SUM(am.count) AS murders FROM agency_monthly am WHERE am.agency IN ('Atlanta','Dallas') AND am.offense = 'Murder' GROUP BY am.agency, am.year",
  },
];
const shrFatalShootingTrendHistory: PromptHistoryMessage[] = [
  { role: "user", content: "fatal shootings in Chicago by year since 2020" },
  {
    role: "assistant",
    content:
      "SELECT i.year, COUNT(*) AS fatal_shootings FROM incidents i WHERE i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' AND i.year >= 2020 GROUP BY i.year",
  },
];

{
  assert.equal(detectFollowupTransform("what about robberies?", currentMonthlyTrendHistory), null);
  assert.equal(detectFollowupTransform("what about 2020?", currentMonthlyTrendHistory), null);
  // "what about <place>" REPLACES the prior geography (MS06): same question, new place
  const transform = detectFollowupTransform("what about Dallas?", currentMonthlyTrendHistory);
  assert(transform);
  assert.equal(transform.name, "replace_geography");
  assert.match(transform.contextQuestion || "", /Dallas/);
  assert.doesNotMatch(transform.contextQuestion || "", /Houston/, "prior geography must be replaced, not kept");
  assert.match(transform.instruction, /REPLACES the prior geography/);
  assert.match(transform.instruction, /compare them/i);
}

{
  // "now do it for <place>" and its siblings are the same replacement (request accounting 2b, owner decision 2026-10-09).
  for (const q of ["now do it for Dallas", "Do the same for Dallas.", "same for Dallas?", "ok, run it for Dallas", "now do the same thing for Dallas"]) {
    const transform = detectFollowupTransform(q, currentMonthlyTrendHistory);
    assert(transform, `${q} should replace the geography`);
    assert.equal(transform.name, "replace_geography");
    assert.match(transform.contextQuestion || "", /Dallas/);
    assert.doesNotMatch(transform.contextQuestion || "", /Houston/, "prior geography must be replaced, not kept");
  }
  assert.equal(detectFollowupTransform("now do it for robberies", currentMonthlyTrendHistory), null, "a non-place target is not a geography replacement");
  assert.equal(detectFollowupTransform("now do it for 2020", currentMonthlyTrendHistory), null, "a year is not a geography replacement");
  assert.equal(detectFollowupTransform("now do it for Dallas", []), null, "no prior answer, nothing to rebuild");
}

{
  const transform = detectFollowupTransform("Compare it to Dallas.", currentMonthlyTrendHistory);
  assert(transform, "compare it to <place> should be detected");
  assert.equal(transform.name, "compare_geographies");
  assert.match(transform.contextQuestion || "", /Dallas/);
}

{
  const transform = detectFollowupTransform("compare this with Fort Worth", currentMonthlyTrendHistory);
  assert(transform, "compare this with <place> should be detected");
  assert.equal(transform.name, "compare_geographies");
}

{
  const transform = detectFollowupTransform("compare to Dallas", currentMonthlyTrendHistory);
  assert(transform);
  assert.equal(transform.name, "compare_geographies");
}

{
  assert.equal(detectFollowupTransform("compare it to last year", currentMonthlyTrendHistory), null);
}

{
  const transform = detectFollowupTransform("split it out by state", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "state");
  assert.match(transform.instruction, /Preserve the prior query's dataset/);
  assert.match(transform.instruction, /PARTITION BY state/);
}

{
  const transform = detectFollowupTransform("break this down by city", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "city");
}

{
  const transform = detectFollowupTransform("show results by agency", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "agency");
}

{
  const transform = detectFollowupTransform("only include agencies that reported every year from 2018 through 2025", historyWithSql);
  assert(transform);
  assert.equal(transform.name, "add_continuous_reporting_filter");
  assert.match(transform.instruction, /nibrs_consistent_reporters/);
  assert.match(transform.instruction, /reported all 12 months in every chosen year/);
}

{
  const transform = detectFollowupTransform("adjust for incomplete coverage", historyWithSql);
  assert(transform);
  assert.equal(transform.name, "add_continuous_reporting_filter");
}

{
  const transform = detectFollowupTransform("Can you give me number instead of rate?", domesticViolenceRateHistory);
  assert(transform);
  assert.equal(transform.name, "replace_rate_with_count");
  assert.match(transform.contextQuestion || "", /raw counts, not rates/);
  assert.match(transform.instruction, /remove population joins/);
  assert.match(transform.instruction, /Do not refuse because the prior query asked for a rate/);
}

{
  const transform = detectFollowupTransform("Is it getting better?", currentMonthlyTrendHistory);
  assert(transform);
  assert.equal(transform.name, "assess_trend");
  assert.match(transform.contextQuestion || "", /monthly murders in Houston since 2021/);
  assert.match(transform.instruction, /Do NOT answer with 'I cannot interpret trends'/);
  assert.match(transform.instruction, /aggregate it to annual totals by year/);
  assert.match(transform.instruction, /Exclude incomplete current-year data/);
  assert.match(transform.instruction, /MUST describe the returned data as annual totals\/rates/);
  assert.match(transform.instruction, /MUST include a direct directional sentence/);
}

{
  const transform = detectFollowupTransform("Are they rising?", currentMonthlyTrendHistory);
  assert(transform);
  assert.equal(transform.name, "assess_trend");
}
{
  const transform = detectFollowupTransform("Is it getting worse?", shrFatalShootingTrendHistory);
  assert(transform);
  assert.equal(transform.name, "assess_trend");
  assert.match(transform.instruction, /preserve that as fatal shootings\/firearm homicides/i);
  assert.match(transform.instruction, /do not refuse/i);
}


{
  const transform = detectFollowupTransform("Which is higher?", comparisonTrendHistory);
  assert(transform);
  assert.equal(transform.name, "assess_trend");
  assert.match(transform.instruction, /which prior series is higher\/lower/);
}

{
  const transform = detectFollowupTransform("How bad is robbery in Chicago? Is it getting worse?", currentMonthlyTrendHistory);
  assert.equal(transform, null);
}

{
  const transform = detectFollowupTransform("Is it getting better?", []);
  assert.equal(transform, null);
}

{
  const transform = detectFollowupTransform("sheriff's office only", [
    { role: "user", content: "show violent crime in Cook County, IL" },
    { role: "assistant", content: "For Cook County, do you want the countywide total (all law enforcement agencies mapped to Cook County, summed — totals depend on each agency's reporting participation) or the sheriff's office only (the single county agency record)? Choose: Countywide total or Sheriff's office only." },
  ]);
  assert(transform);
  assert.equal(transform.name, "resolve_county_scope");
  // Historical is resolved through the FIPS crosswalk, not by agency name. The clause used
  // to name "Cook County" as the canonical database name; the rebuilt directory spells that
  // agency "Cook", so any instruction to match a name is an instruction to return nothing.
  assert.match(transform.instruction, /agency_county_crosswalk/);
  assert.match(transform.instruction, /cw\.county_key/);
  assert.match(transform.instruction, /LOWER\(ha\.type\) = 'county'/);
  // The synthesised name may only appear as something not to match on.
  assert.match(transform.instruction, /do NOT match the county by agency name/);
  assert.match(transform.instruction, /not a synthesised "Cook County"/);
  // Two county agencies must be asked about, not summed.
  assert.match(transform.instruction, /ask which one rather than summing/);
  assert.match(transform.instruction, /agency = 'Maricopa' AND type = 'County'/);
  assert.match(transform.instruction, /do not search agencies\.city = 'COOK COUNTY'/);
}

{
  const transform = detectFollowupTransform("please show just victim demographics.", domesticViolenceRateHistory);
  assert(transform);
  assert.equal(transform.name, "replace_with_dv_victim_demographics");
  assert.match(transform.instruction, /replaces the prior domestic-violence metric/);
  assert.match(transform.instruction, /Do NOT preserve any prior per-capita/);
  assert.match(transform.instruction, /victim_sequence/);
}

{
  const transform = detectFollowupTransform("split it out by state", [
    { role: "user", content: "show murder trends" },
    { role: "assistant", content: "Here is the chart." },
  ]);
  assert.equal(transform, null);
}

{
  const transform = detectFollowupTransform("crime by state", historyWithSql);
  assert.equal(transform, null);
}

// --- restrict_scope: "just/only X" fragments reconstruct from the prior user question ---
// Production 8375/8376: the 32-city question produced no SQL, so every prior
// detector (which all require prior SQL) declined, the resolver never ran, and
// the model matched agencies by city name.
{
  const failedFirstTurn: PromptHistoryMessage[] = [
    { role: "user", content: "give me number of murders and murder clearances by type for 2025 for these cities: Chicago, IL New York City, NY Houston, TX" },
    { role: "assistant", content: "I could not generate a database query for that request in the NIBRS source. Please restate it with the place, offense, and date range you want." },
  ];
  const transform = detectFollowupTransform("just clearances by type", failedFirstTurn);
  assert(transform, "restrictive fragment must be detected even when the prior turn produced no SQL");
  assert.equal(transform.name, "restrict_scope");
  assert.match(transform.contextQuestion ?? "", /Chicago, IL/);
  assert.match(transform.contextQuestion ?? "", /just clearances by type/);
  assert.match(transform.instruction, /\[SYSTEM:/);
}

{
  // No prior user question -> no transform (standalone "just ..." questions pass through)
  assert.equal(detectFollowupTransform("just clearances by type", []), null);
}

{
  // Conversational fragments must not fire
  assert.equal(detectFollowupTransform("just curious, thanks", historyWithSql), null);
}

{
  // Specialized transforms still win over the generic fragment branch
  const transform = detectFollowupTransform("just show victim demographics", domesticViolenceRateHistory);
  assert(transform);
  assert.equal(transform.name, "replace_with_dv_victim_demographics");
}

{
  // A breakdown request with prior SQL still routes to add_breakdown
  const transform = detectFollowupTransform("just break it down by state", historyWithSql);
  assert(transform);
  assert.equal(transform.name, "add_breakdown");
}

// A fragment carrying BOTH its own place and its own offense is a complete
// question, not a restriction — inheriting would graft two unrelated asks.
{
  const priorRobbery: PromptHistoryMessage[] = [
    { role: "user", content: "robberies in Chicago in 2024" },
    { role: "assistant", content: "SELECT year, robbery FROM summary_city_monthly" },
  ];
  assert.equal(detectFollowupTransform("only murders in Dallas in 2025", priorRobbery), null);
  assert.equal(detectFollowupTransform("just homicides in Baltimore", priorRobbery), null);

  // One or the other is still a real restriction of the prior question
  assert.equal(detectFollowupTransform("only murders", priorRobbery)?.name, "restrict_scope");
  assert.equal(detectFollowupTransform("just clearances for Chicago", priorRobbery)?.name, "restrict_scope");
  assert.equal(detectFollowupTransform("just clearances by type", priorRobbery)?.name, "restrict_scope");
}

console.log("follow-up transform tests passed");
