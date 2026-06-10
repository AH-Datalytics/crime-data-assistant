/**
 * Deterministic router test harness.
 * Tests autoRoute() against golden test cases from production queries + synthetic edge cases.
 * Run: npx tsx scripts/test-router.ts
 */

import { autoRoute, isFollowUp, manualSourceNudge, parseIntent, type TabId } from "../lib/tab-suggest";

interface TestCase {
  question: string;
  expectedPrimary: TabId | TabId[]; // one or multiple acceptable primaries
  allowedFull?: TabId[];            // datasets allowed as full answers (primary + alts)
  mustExclude?: TabId[];            // datasets that must NOT be primary or full alternative
  unsupported?: string[];           // expected unsupported concepts
  expectFollowUp?: boolean;         // expected isFollowUp result
  note?: string;                    // explanation for reviewers
}

let pass = 0;
let fail = 0;
const failures: { question: string; issue: string }[] = [];

function test(tc: TestCase) {
  const route = autoRoute(tc.question);
  const intent = parseIntent(tc.question);
  const primary = route?.source || null;
  const allFull = route ? [route.source, ...route.alternatives.map(a => a.tab)] : [];

  // Check follow-up detection
  if (tc.expectFollowUp !== undefined) {
    const actual = isFollowUp(tc.question);
    if (actual !== tc.expectFollowUp) {
      fail++;
      failures.push({ question: tc.question, issue: `isFollowUp: got ${actual}, expected ${tc.expectFollowUp}` });
      return;
    }
    // For follow-up tests, primary routing is less important — the UI keeps the current tab
    if (tc.expectFollowUp) {
      pass++;
      return;
    }
  }

  // Check primary
  const expectedPrimaries = Array.isArray(tc.expectedPrimary) ? tc.expectedPrimary : [tc.expectedPrimary];
  if (!primary || !expectedPrimaries.includes(primary)) {
    fail++;
    failures.push({ question: tc.question, issue: `Primary: got ${primary}, expected ${expectedPrimaries.join("|")}` });
    return;
  }

  // Check exclusions
  if (tc.mustExclude) {
    for (const excl of tc.mustExclude) {
      if (allFull.includes(excl)) {
        fail++;
        failures.push({ question: tc.question, issue: `${excl} should be excluded but is in full answers: [${allFull.join(",")}]` });
        return;
      }
    }
  }

  // Check unsupported concepts
  if (tc.unsupported) {
    for (const u of tc.unsupported) {
      if (!intent.unsupportedConcepts.includes(u)) {
        fail++;
        failures.push({ question: tc.question, issue: `Expected unsupported concept "${u}" not detected` });
        return;
      }
    }
  }

  pass++;
}

function testNudge(question: string, activeSource: TabId, expectedSource: TabId | null) {
  const nudge = manualSourceNudge(question, activeSource);
  const actual = nudge?.source || null;
  if (actual !== expectedSource) {
    fail++;
    failures.push({ question, issue: `Manual source nudge from ${activeSource}: got ${actual}, expected ${expectedSource}` });
    return;
  }
  pass++;
}

// ══════════════════════════════════════════════════════════════════════
//  SECTION 1: Required spec cases (from Codex)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Required spec cases ═══");

test({ question: "firearm murders in Houston since 2010", expectedPrimary: "shr", mustExclude: ["current", "historical"], note: "weapon required" });
test({ question: "murders in Houston since 2010", expectedPrimary: "historical" });
test({ question: "monthly murders in Houston since 2018", expectedPrimary: "current" });
test({ question: "murder victim race in Houston since 2010", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });
test({ question: "clearance rate for murder since 1960", expectedPrimary: "historical" });
test({ question: "cleared by arrest vs exceptional means", expectedPrimary: "nibrs" });
test({ question: "marijuana arrests", expectedPrimary: "nibrs", unsupported: ["specific_drug_arrests"] });
test({ question: "marijuana drug offenses", expectedPrimary: "nibrs" });
test({ question: "police staffing in Chicago since 1980", expectedPrimary: "historical" });
test({ question: "hate crimes in Texas", expectedPrimary: "hate_crime" });
test({ question: "domestic homicides since 1980", expectedPrimary: "shr" });
test({ question: "shootings in Chicago", expectedPrimary: "shr" });
test({ question: "crime in Alameda County since 2008", expectedPrimary: "historical" });
test({ question: "violent crime in DC from 2014", expectedPrimary: "historical" });
test({ question: "carjacking clearance rates", expectedPrimary: "nibrs" });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 2: Production failure cases (from query log audit)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Production failure cases ═══");

// 3109: DC violent crime from 2014 — broad category, long range
test({ question: "rate of violent crime in Washington DC from 2014 to today", expectedPrimary: "historical" });
// 3113: DUI → Group B
test({ question: "national trend in DWI/DUI from 2000 to today", expectedPrimary: "nibrs" });
// 3132: hate crime on Current → should redirect to Hate Crime tab
test({ question: "Show me trends in hate crime", expectedPrimary: "hate_crime" });
// 3143/3144: Macon not in RTCI sample → should still route to Current or Historical
test({ question: "homicide rate in Macon Georgia over 5 years", expectedPrimary: ["historical", "current"] });
// 3164: juvenile crime → needs demographics
test({ question: "How do juvenile crime rates compare to criminal rates", expectedPrimary: "nibrs" });
// 3166: juvenile vs adult arrests
test({ question: "How do juvenile arrest rates compare to adult rates", expectedPrimary: "nibrs" });
// 3169: carjacking on Current → should be NIBRS
test({ question: "Carjackings in boston since 2025", expectedPrimary: "nibrs" });
// 3170: gang homicides → SHR has circumstance
test({ question: "Examine trends in gang homicides in Chicago IL over time", expectedPrimary: "shr" });
// 3176: gang murders NIBRS → circumstance needed
test({ question: "How many gang murders have there been in Chicago over time?", expectedPrimary: "shr" });
// 3180: crime rates vs staffing → Historical for staffing
test({ question: "Compare crime rates vs police staffing levels across the 20 largest cities in the US", expectedPrimary: "historical" });
// 3182: carjacking data for NOLA
test({ question: "Do you have carjacking data for new orleans by month?", expectedPrimary: "nibrs" });
// 3188: marijuana possession arrests
test({ question: "marijuana possession arrests", expectedPrimary: "nibrs", unsupported: ["specific_drug_arrests"] });
// 3192: officers in Chicago
test({ question: "How many officers are with the Chicago police department by year total?", expectedPrimary: "historical" });
// 3200: clearance rates for auto theft
test({ question: "What is the clearance rates for auto theft in Philadelphia and Chicago?", expectedPrimary: "historical" });
// 3232: juvenile crime in Kansas
test({ question: "show me the trend of juvenile crime in Kansas since 2020", expectedPrimary: "nibrs" });
// 3242: homicide by relationship, pre-NIBRS
test({ question: "Homicide of female by a relative 1975-2023", expectedPrimary: "shr", mustExclude: ["current", "historical"] });
// 3249: video evidence clearance → unsupported
test({ question: "what percentage of clearances have video evidence", expectedPrimary: ["nibrs", "historical"], unsupported: ["evidence_type"] });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 3: Production success cases (should continue routing correctly)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Production success cases ═══");

test({ question: "Show me theft in Omaha rolling over 12 months", expectedPrimary: "current" });
test({ question: "Give me robbery numbers in Houston 2020-2025", expectedPrimary: ["current", "historical"] });
test({ question: "Can I see the top 10 auto theft rates in 2025?", expectedPrimary: ["current", "historical"] });
test({ question: "Show me the national murder trend from 2000 to 2020", expectedPrimary: "historical" });
test({ question: "Give me the national robbery clearance rate since 1960", expectedPrimary: "historical" });
test({ question: "Can I see Chicago officers per year?", expectedPrimary: "historical" });
test({ question: "Show me vehicle burglaries per month in Boston in 2023", expectedPrimary: ["nibrs", "current"] });
test({ question: "Can I see murders by weapon in Houston in 2025?", expectedPrimary: ["nibrs", "shr"], mustExclude: ["current", "historical"] });
test({ question: "Show me which big cities had the highest share of firearm murders in 2024", expectedPrimary: "shr", mustExclude: ["current", "historical"] });
test({ question: "Give me domestic homicide trends nationally since 2000", expectedPrimary: "shr" });
test({ question: "Percentage of inter racial homicide 1975-2023", expectedPrimary: "shr" });
test({ question: "Compare the total annual number of homicides in Baltimore and Chicago over the past 10 years", expectedPrimary: "historical" });
test({ question: "What are the clearance rates for auto theft in Philadelphia and Chicago?", expectedPrimary: "historical" });
test({ question: "Murder rate in California since 1960", expectedPrimary: "historical" });
test({ question: "Denver murders by month from 2018 to present", expectedPrimary: "current" });
test({ question: "Compare auto thefts between Philadelphia and Chicago", expectedPrimary: ["current", "historical"] });
test({ question: "Houston carjackings since 2019", expectedPrimary: "nibrs" });
test({ question: "domestic murders in dallas per year since 2020", expectedPrimary: "shr" });
test({ question: "US murders per year", expectedPrimary: "historical" });
test({ question: "how many violent offenses involved a firearm?", expectedPrimary: ["nibrs", "shr"], mustExclude: ["current", "historical"] });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 4: Synthetic attribute coverage tests
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Synthetic attribute coverage ═══");

// Weapon
test({ question: "knife murders nationally", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"], note: "weapon attribute" });
test({ question: "blunt object assaults in Texas", expectedPrimary: "nibrs", mustExclude: ["current", "historical"] });

// Relationship
test({ question: "intimate partner homicides since 1990", expectedPrimary: "shr", mustExclude: ["current", "historical"], note: "relationship attribute — NIBRS also has relationship but SHR is primary for this" });
test({ question: "stranger homicides vs acquaintance homicides", expectedPrimary: "shr", mustExclude: ["current", "historical"] });

// Victim demographics
test({ question: "female murder victims in California", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });
test({ question: "murder victims by age group nationally", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });
test({ question: "Black murder victims by year since 2000", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });

// Offender demographics
test({ question: "offender race in robberies", expectedPrimary: "nibrs", mustExclude: ["current", "historical"] });
test({ question: "offender age in aggravated assaults", expectedPrimary: "nibrs", mustExclude: ["current", "historical"] });
test({ question: "murder offender demographics in NYC", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });

// Arrestee demographics
test({ question: "drug arrest demographics in Ohio", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });
test({ question: "DUI arrests by age group", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });

// Drug type
test({ question: "heroin offenses by state", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });
test({ question: "meth vs cocaine drug violations trend", expectedPrimary: "nibrs" });

// Hate crime / bias → dedicated Hate Crime tab
test({ question: "anti-Asian hate crimes since 2019", expectedPrimary: "hate_crime", mustExclude: ["current", "historical", "shr"] });
test({ question: "bias-motivated offenses by type", expectedPrimary: "hate_crime" });

// Clearance rate (basic)
test({ question: "robbery clearance rate in New York since 1990", expectedPrimary: "historical" });
test({ question: "national murder clearance rate trend", expectedPrimary: "historical" });

// Clearance type (arrest vs exceptional)
test({ question: "what percentage of murders are cleared by arrest vs exceptional", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });
test({ question: "exceptional clearance rate for robbery", expectedPrimary: "nibrs" });

// Staffing
test({ question: "sworn officers per capita in big cities", expectedPrimary: "historical", mustExclude: ["current", "nibrs", "shr"] });
test({ question: "NYPD staffing levels since 1970", expectedPrimary: "historical" });

// Monthly trends
test({ question: "monthly robbery trend in Seattle", expectedPrimary: "current" });
test({ question: "month by month murder data for Memphis 2022-2025", expectedPrimary: "current" });

// Pre-2017 trends
test({ question: "burglary trend since 1985", expectedPrimary: "historical" });
test({ question: "murder rate in the 1990s", expectedPrimary: "historical" });

// County geography
test({ question: "crime in Harris County Texas", expectedPrimary: "historical" });
test({ question: "murder in Jefferson Parish Louisiana", expectedPrimary: "historical" });

// Circumstance
test({ question: "felony murder vs argument murder trend", expectedPrimary: "shr", mustExclude: ["current", "historical"] });
test({ question: "justifiable homicides by police since 2000", expectedPrimary: "shr" });

// Carjacking
test({ question: "carjacking trend in Washington DC", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });
test({ question: "carjacking by weapon type", expectedPrimary: "nibrs" });

// Location type
test({ question: "assaults by location type in Florida", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });

// Time of day
test({ question: "robberies by time of day", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"] });

// Unsupported: evidence type
test({ question: "how many cases used DNA evidence", expectedPrimary: ["nibrs", "historical"], unsupported: ["evidence_type"] });
test({ question: "clearances with surveillance camera footage", expectedPrimary: ["nibrs", "historical"], unsupported: ["evidence_type"] });

// Shooting contract: bare shootings → SHR, nonfatal → SHR (refusal), fatal → SHR, proxy → NIBRS
test({ question: "mass shootings in the US", expectedPrimary: "shr" });
test({ question: "shooting victims in Philadelphia", expectedPrimary: "shr" });
test({ question: "fatal shootings in Houston since 2015", expectedPrimary: "shr" });
test({ question: "nonfatal shootings in Dallas", expectedPrimary: "shr" });
test({ question: "people shot in Chicago", expectedPrimary: "shr" });
test({ question: "aggravated assault with firearm in Dallas", expectedPrimary: "nibrs" });

// Unsupported: convictions/prosecution
test({ question: "conviction rates for murder", expectedPrimary: ["historical", "nibrs"], unsupported: ["convictions"] });
test({ question: "how many offenders were sentenced to prison", expectedPrimary: ["historical", "nibrs"], unsupported: ["convictions"] });

// Mixed: simple questions that shouldn't over-route
test({ question: "how much crime is there in the US", expectedPrimary: "historical" });
test({ question: "is crime going up or down", expectedPrimary: ["current", "historical"] });
test({ question: "total murders in 2024", expectedPrimary: ["historical", "current", "nibrs"] });
test({ question: "crime in Denver", expectedPrimary: ["historical", "current"] });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 5: Additional production queries (diverse phrasing)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Production phrasing diversity ═══");

test({ question: "What five cities are currently experiencing the greatest number of homicides?", expectedPrimary: ["current", "historical"] });
test({ question: "Can you please show me the aggravated assault rates for New York City by year from 2019 to 2025?", expectedPrimary: ["current", "historical"] });
test({ question: "Compare the number of Chicago officers to NYPD officers per year", expectedPrimary: "historical" });
test({ question: "What are the trends in auto thefts in Philadelphia?", expectedPrimary: ["current", "historical"] });
test({ question: "What is rate of homicide in nyc?", expectedPrimary: ["current", "historical"] });
test({ question: "how many aggravated assault incidents involve multiple victims?", expectedPrimary: "nibrs" });
test({ question: "What percentage of murder victims in Texas were female in 2023?", expectedPrimary: ["nibrs", "shr"], mustExclude: ["current", "historical"] });
test({ question: "What are the most common weapons used in aggravated assault nationally?", expectedPrimary: "nibrs", mustExclude: ["current", "historical"] });
test({ question: "How many carjackings were reported in California from 2019 to 2024?", expectedPrimary: "nibrs" });
test({ question: "Show drug offense trends by drug type in Ohio", expectedPrimary: "nibrs" });
test({ question: "What is the clearance rate for rape in Florida by year?", expectedPrimary: ["historical", "nibrs"] });
test({ question: "Compare murder offender demographics in Chicago vs Houston in 2023", expectedPrimary: ["nibrs", "shr"], mustExclude: ["current", "historical"] });
test({ question: "What percentage of murders involved a firearm by year since 1990?", expectedPrimary: "shr", mustExclude: ["current", "historical"] });
test({ question: "Break down homicide circumstances in Texas in 2023", expectedPrimary: "shr", mustExclude: ["current", "historical", "nibrs"] });
test({ question: "What share of homicides are intraracial since 2000?", expectedPrimary: "shr" });
test({ question: "Victim age and sex breakdown for murders in California in 2022", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"] });
test({ question: "What New Orleans violent crime data do you have for the past 3 years?", expectedPrimary: ["current", "historical"] });
test({ question: "what are the crime trends for Fairfax County Virginia Police Department for the past three years?", expectedPrimary: "current" });
test({ question: "can you tell me the current crime in Fairfax County Virginia?", expectedPrimary: "current" });
test({ question: "Which cities had the most officers per capita?", expectedPrimary: "historical" });
test({ question: "counties with most reported data in 2025", expectedPrimary: ["current", "historical"] });
test({ question: "Show me the homicide levels for Dallas, Texas between 2021 to June 2026.", expectedPrimary: "current" });
test({ question: "compare crime in the top 10 cities in texas", expectedPrimary: ["current", "historical"] });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 6: Follow-up detection (session continuations)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Follow-up detection ═══");

// Formatting / display instructions
test({ question: "Make the graph green", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Ok but make the DC line yellow", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "remove 2017", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Normalize that please", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Make it a pie chart", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "in a table", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "as a bar chart", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Your chart looks weird.", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "get rid of 2026 since there's no data", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Great. Now add a vertical line for August 2025", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "index to 100 from 2017 for each region so we can compare over time", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "Roll that over 12 months", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "trim the end date to 2025", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "now make it per capita", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "now take out robbery", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "can you make that a line chart", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "can you combine the year and month into a date (MMM-YY) on the table?", expectedPrimary: "historical", expectFollowUp: true });

// Short confirmations / rejections
test({ question: "yes", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "no", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "never mind, go back", expectedPrimary: "historical", expectFollowUp: true });

// Context references
test({ question: "Could you do the same for 2024", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "what if you lower the number to 25 homicides in 2019", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "how about just counties in VA", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "what about cleared by arrest?", expectedPrimary: "historical", expectFollowUp: true });

// Comparison / measure change follow-ups (new patterns)
test({ question: "compare to Dallas", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "compare to New York", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "show rates instead of counts", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "break it down by bias type", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "show participation over time", expectedPrimary: "historical", expectFollowUp: true });

// Anaphoric follow-ups from the 2026-06-09 audit
test({ question: "show this from 2019 to present", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "show this with Los Angeles, Houston and New York", expectedPrimary: "historical", expectFollowUp: true });
test({ question: "can you show me the rate", expectedPrimary: "historical", expectFollowUp: true });

// Follow-up that adds hard requirement — should NOT be treated as pure follow-up
// (V2 component handles the reroute, but isFollowUp still returns true — the UI reroutes)
test({ question: "now show firearm murders instead", expectedPrimary: "historical", expectFollowUp: true, note: "isFollowUp=true but V2 detects weapon attr and reroutes" });

// NOT follow-ups — these have clear standalone intent
test({ question: "Murder rate in Houston per 100K", expectedPrimary: ["historical", "current"], expectFollowUp: false });
test({ question: "firearm murders in Houston since 2010", expectedPrimary: "shr", expectFollowUp: false });
test({ question: "Show me hate crimes in Texas", expectedPrimary: "hate_crime", expectFollowUp: false });
test({ question: "carjacking trend in Washington DC", expectedPrimary: "nibrs", expectFollowUp: false });
test({ question: "national murder clearance rate trend", expectedPrimary: "historical", expectFollowUp: false });
test({ question: "domestic homicides since 1980", expectedPrimary: "shr", expectFollowUp: false });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 7: Ambiguous geography
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Ambiguous geography ═══");

// Washington DC vs Washington state
test({ question: "murder rate in Washington DC", expectedPrimary: ["current", "historical"], note: "DC is a city" });
test({ question: "murder rate in Washington state", expectedPrimary: "historical", note: "Washington state → state-level" });
test({ question: "crime in DC", expectedPrimary: ["current", "historical"] });

// Portland — both OR and ME exist, router should still work
test({ question: "murders in Portland", expectedPrimary: ["current", "historical"], note: "Ambiguous Portland — either city works" });
test({ question: "Portland Oregon murder trend", expectedPrimary: ["current", "historical"] });

// Kansas City — exists in MO and KS
test({ question: "violent crime in Kansas City", expectedPrimary: ["current", "historical"], note: "Kansas City is ambiguous MO/KS" });

// State names that are also city-adjacent
test({ question: "crime rate in Georgia", expectedPrimary: "historical", note: "Georgia → state" });
test({ question: "crime in Atlanta Georgia", expectedPrimary: ["current", "historical"], note: "City + state" });

// County detection
test({ question: "crime in Cook County Illinois", expectedPrimary: "historical", note: "County → Historical" });
test({ question: "murders in Los Angeles County", expectedPrimary: "historical", note: "LA County" });

// ══════════════════════════════════════════════════════════════════════
//  SECTION 8: Word-change routing (same topic, different attributes)
// ══════════════════════════════════════════════════════════════════════

console.log("═══ Word-change routing ═══");

// "murders" → Historical, "firearm murders" → SHR (weapon), "murder victim race" → SHR/NIBRS (demo)
test({ question: "murders in Houston", expectedPrimary: ["historical", "current"], note: "Plain murders → no special attributes" });
test({ question: "firearm murders in Houston", expectedPrimary: "shr", mustExclude: ["current", "historical"], note: "Adding 'firearm' → weapon attribute → SHR" });
test({ question: "murder victim race in Houston", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"], note: "Adding 'victim race' → demographic → SHR/NIBRS" });

// "robbery" → Current/Historical, "robbery by weapon" → NIBRS, "robbery clearance rate" → Historical
test({ question: "robbery in Philadelphia", expectedPrimary: ["current", "historical"], note: "Plain robbery" });
test({ question: "robbery by weapon type in Philadelphia", expectedPrimary: "nibrs", mustExclude: ["current", "historical"], note: "Adding weapon type → NIBRS" });
test({ question: "robbery clearance rate in Philadelphia since 1990", expectedPrimary: "historical", note: "Clearance rate → Historical" });

// "crime" → Historical, "crime by location type" → NIBRS
test({ question: "crime trend nationally", expectedPrimary: "historical" });
test({ question: "crime by location type nationally", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"], note: "Location type → NIBRS-only attribute" });

// "homicides" → Historical, "domestic homicides" → SHR, "homicide offender race" → SHR/NIBRS
test({ question: "homicides in Texas since 2000", expectedPrimary: "historical" });
test({ question: "domestic homicides in Texas since 2000", expectedPrimary: "shr", note: "domestic → relationship → SHR" });
test({ question: "homicide offender race in Texas", expectedPrimary: ["shr", "nibrs"], mustExclude: ["current", "historical"], note: "Offender demographics → SHR/NIBRS" });

// "arrests" → NIBRS (demographics), "juvenile arrests" → NIBRS (arrest_demographics)
test({ question: "total arrests nationally", expectedPrimary: ["historical", "nibrs"], note: "Generic arrests" });
test({ question: "juvenile arrests by race", expectedPrimary: "nibrs", mustExclude: ["current", "historical", "shr"], note: "Juvenile + race → arrest demographics → NIBRS" });
test({ question: "misdemeanor arrests in Pennsylvania", expectedPrimary: ["historical", "nibrs"], unsupported: ["charge_severity"], note: "No source has misdemeanor/felony charge class; durable behavior is unsupported detection plus guardrail override" });

console.log("═══ Manual source nudges ═══");

testNudge("carjacking trend in Washington DC", "current", "nibrs");
testNudge("Show me hate crimes in Texas", "current", "hate_crime");
testNudge("domestic homicides since 1980", "historical", "shr");
testNudge("carjacking trend in Washington DC", "nibrs", null);
testNudge("Make the graph green", "current", null);

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`ROUTER TESTS: ${pass} passed, ${fail} failed out of ${pass + fail}`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  FAIL: ${f.question}`);
    console.log(`        ${f.issue}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
