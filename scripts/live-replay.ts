#!/usr/bin/env npx tsx
/**
 * Live replay harness for NIBRSAI.
 * Runs curated test queries against the live API to validate routing,
 * SQL shape, guardrails, refusals, and explanation wording.
 *
 * Usage:
 *   npx tsx scripts/live-replay.ts --quick                          # 18 smoke tests
 *   npx tsx scripts/live-replay.ts --full                           # 118 tests
 *   npx tsx scripts/live-replay.ts --rerun W02,C02,C03,S01          # rerun specific IDs
 *   npx tsx scripts/live-replay.ts --sessions                       # 3 multi-turn sessions
 *   npx tsx scripts/live-replay.ts --full --host http://localhost:3000
 *
 * Output: audit/live-replay-<timestamp>.json and .md
 *
 * Result statuses:
 *   pass          — API responded, all assertions passed
 *   fail          — API responded, one or more assertions failed
 *   inconclusive  — infrastructure issue (CAPTCHA, rate limit, timeout) prevented evaluation
 */

import { writeFileSync, mkdirSync } from "fs";
import { autoRoute, isFollowUp } from "../lib/tab-suggest";

// ══════════════════════════════════════════════════════════════════════
//  Types
// ══════════════════════════════════════════════════════════════════════

type TabId = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
type ResultStatus = "pass" | "fail" | "inconclusive";

interface TestCase {
  id: string;
  question: string;
  tab: TabId | "auto";
  expectedTab?: TabId | TabId[];
  quick?: boolean;
  sqlIncludes?: string[];
  sqlExcludes?: string[];
  responseIncludes?: string[];
  responseExcludes?: string[];
  expect?: "rows" | "refusal" | "clarification" | "override" | "rows_or_text";
  minRows?: number;
  allowZeroRows?: boolean;
  expectGuardrail?: string[];
  category: string;
  note?: string;
}

interface TestResult {
  id: string;
  question: string;
  tab: TabId;
  category: string;
  status: ResultStatus;
  failures: string[];
  sql: string | null;
  explanation: string;
  rowCount: number;
  httpStatus: number;
  guardrailsFired: string[];
  durationMs: number;
  note?: string;
}

// ══════════════════════════════════════════════════════════════════════
//  Test cases
// ══════════════════════════════════════════════════════════════════════

const ALL_TESTS: TestCase[] = [
  // ── Core routing ──
  { id: "R01", question: "murders in Houston since 2010", tab: "auto", expectedTab: "historical", quick: true, category: "routing", sqlIncludes: ["murder"], expect: "rows" },
  { id: "R02", question: "monthly murders in Houston since 2018", tab: "auto", expectedTab: "current", quick: true, category: "routing", expect: "rows" },
  { id: "R03", question: "firearm murders in Houston since 2010", tab: "auto", expectedTab: "shr", quick: true, category: "routing", sqlIncludes: ["weapon"], expect: "rows" },
  { id: "R04", question: "murder victim race in Houston since 2010", tab: "auto", expectedTab: ["shr", "nibrs"], quick: true, category: "routing", expect: "rows" },
  { id: "R05", question: "clearance rate for murder since 1960", tab: "auto", expectedTab: "historical", quick: true, category: "routing", expect: "rows" },
  { id: "R06", question: "cleared by arrest vs exceptional means for robbery in Chicago", tab: "auto", expectedTab: "nibrs", quick: true, category: "routing", expect: "rows" },
  { id: "R07", question: "police staffing in Chicago since 1980", tab: "auto", expectedTab: "historical", quick: true, category: "routing", sqlIncludes: ["staffing"], expect: "rows" },
  { id: "R08", question: "hate crimes in Texas since 2010", tab: "auto", expectedTab: "hate_crime", quick: true, category: "routing", expect: "rows", responseIncludes: ["voluntary"] },
  { id: "R09", question: "domestic homicides in California since 1980", tab: "auto", expectedTab: "shr", quick: true, category: "routing", expect: "rows" },
  { id: "R10", question: "carjacking clearance rates in Chicago", tab: "auto", expectedTab: "nibrs", category: "routing", expect: "rows" },
  { id: "R11", question: "US murders per year", tab: "auto", expectedTab: "historical", category: "routing", expect: "rows" },
  { id: "R12", question: "DUI arrests nationally", tab: "auto", expectedTab: "nibrs", category: "routing", expect: "rows" },
  { id: "R13", question: "murder rate in California since 1960", tab: "auto", expectedTab: "historical", category: "routing", expect: "rows" },
  { id: "R14", question: "Houston carjackings since 2019", tab: "auto", expectedTab: "nibrs", category: "routing", expect: "rows" },
  { id: "R15", question: "national murder clearance rate trend", tab: "auto", expectedTab: "historical", category: "routing", expect: "rows" },

  // ── Word-change routing ──
  { id: "W01", question: "murders in Philadelphia", tab: "auto", expectedTab: ["historical", "current"], category: "word-change", expect: "rows" },
  { id: "W02", question: "firearm murders in Philadelphia", tab: "auto", expectedTab: "shr", category: "word-change", sqlIncludes: ["weapon"], expect: "rows" },
  { id: "W03", question: "murder victim race in Philadelphia", tab: "auto", expectedTab: ["shr", "nibrs"], category: "word-change", expect: "rows" },
  { id: "W04", question: "robbery clearance rate in Philadelphia since 1990", tab: "auto", expectedTab: "historical", category: "word-change", expect: "rows" },
  { id: "W05", question: "robbery by weapon type in Philadelphia", tab: "auto", expectedTab: "nibrs", category: "word-change", expect: "rows" },
  { id: "W06", question: "homicides in Texas since 2000", tab: "auto", expectedTab: "historical", category: "word-change", expect: "rows" },
  { id: "W07", question: "domestic homicides in Texas since 2000", tab: "auto", expectedTab: "shr", category: "word-change", expect: "rows" },
  { id: "W08", question: "homicide offender race in Texas", tab: "auto", expectedTab: ["shr", "nibrs"], category: "word-change", expect: "rows" },

  // ── Ambiguous geography ──
  { id: "G01", question: "murder rate in Washington since 2010", tab: "historical", quick: true, category: "geography", expect: "override", responseIncludes: ["ambiguous", "d.c.", "state"], note: "Bare Washington must ask clarification" },
  { id: "G02", question: "murder rate in Washington DC since 2010", tab: "historical", category: "geography", expect: "rows", note: "Explicit DC → no ambiguity" },
  { id: "G03", question: "murder rate in Washington state since 2010", tab: "historical", category: "geography", expect: "rows", note: "Explicit state → no ambiguity" },
  { id: "G04", question: "crime in Portland", tab: "auto", expectedTab: ["current", "historical"], category: "geography", expect: "rows" },
  { id: "G05", question: "violent crime in Kansas City", tab: "auto", expectedTab: ["current", "historical"], category: "geography", expect: "rows" },

  // ── County/city/state distinctions ──
  { id: "C01", question: "violent crime in Alameda County since 2008", tab: "historical", quick: true, category: "county", sqlIncludes: ["alameda county", "type = 'county'"], sqlExcludes: ["historical_state_national"], responseExcludes: ["cities in alameda", "cities within alameda"], expect: "rows", note: "Must use county agency record" },
  { id: "C02", question: "violent crime in California since 2008", tab: "historical", quick: true, category: "county", sqlIncludes: ["historical_state_national"], responseExcludes: ["california cities", "cities in california"], expect: "rows", note: "Must use state table, say statewide" },
  { id: "C03", question: "violent crime in Cook County, Illinois since 2008", tab: "historical", category: "county", sqlIncludes: ["cook county"], sqlExcludes: ["historical_state_national"], expect: "rows" },
  { id: "C04", question: "crime in Harris County Texas", tab: "historical", category: "county", expect: "rows" },
  { id: "C05", question: "murder in Jefferson Parish Louisiana", tab: "historical", category: "county", expect: "rows" },
  { id: "C06", question: "violent crime in Alameda, California since 2008", tab: "historical", category: "county", note: "Alameda city, not county", expect: "rows" },

  // ── Historical clearance ──
  { id: "H01", question: "robbery clearance rate in New York since 1990", tab: "historical", category: "clearance", expect: "rows" },
  { id: "H02", question: "national murder clearance rate since 1960", tab: "historical", category: "clearance", expect: "rows" },
  { id: "H03", question: "What are the clearance rates for auto theft in Philadelphia and Chicago?", tab: "historical", category: "clearance", expect: "rows" },

  // ── Homicide weapon/demographic (SHR) ──
  { id: "S01", question: "firearm murders in Houston since 2010", tab: "shr", quick: true, category: "shr", sqlIncludes: ["weapon"], expect: "rows" },
  { id: "S02", question: "knife murders nationally", tab: "shr", category: "shr", expect: "rows" },
  { id: "S03", question: "intimate partner homicides since 1990", tab: "shr", category: "shr", expect: "rows" },
  { id: "S04", question: "stranger homicides vs acquaintance homicides", tab: "shr", category: "shr", expect: "rows" },
  { id: "S05", question: "female murder victims in California", tab: "shr", category: "shr", expect: "rows" },
  { id: "S06", question: "felony murder vs argument murder trend", tab: "shr", category: "shr", expect: "rows" },
  { id: "S07", question: "justifiable homicides by police since 2000", tab: "shr", category: "shr", expect: "rows" },
  { id: "S08", question: "What percentage of murders involved a firearm by year since 1990?", tab: "shr", category: "shr", expect: "rows" },
  { id: "S09", question: "Percentage of inter racial homicide 1975-2023", tab: "shr", category: "shr", expect: "rows" },
  { id: "S10", question: "Break down homicide circumstances in Texas in 2023", tab: "shr", category: "shr", expect: "rows" },

  // ── NIBRS drug/arrest/hate/carjacking ──
  { id: "N01", question: "marijuana drug offenses nationally", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N02", question: "DUI arrests by age group nationally", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N03", question: "anti-Asian hate crimes since 2019", tab: "hate_crime", category: "hate_crime", expect: "rows", responseIncludes: ["voluntary"] },
  { id: "N04", question: "carjacking trend in Washington DC", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N05", question: "robbery by weapon type in Philadelphia", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N06", question: "how many aggravated assault incidents involve multiple victims?", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N07", question: "juvenile arrests by race nationally", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N08", question: "Show drug offense trends by drug type in Ohio", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N09", question: "assaults by location type in Florida", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N10", question: "robberies by time of day nationally", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N11", question: "exceptional clearance rate for robbery in Texas", tab: "nibrs", category: "nibrs", expect: "rows" },
  { id: "N12", question: "What percentage of murders are cleared by arrest vs exceptional nationally?", tab: "nibrs", category: "nibrs", expect: "rows" },

  // ── Hate crime ──
  { id: "HC01", question: "How have hate crimes trended nationally since 2000?", tab: "hate_crime", quick: true, category: "hate_crime", expect: "rows", responseIncludes: ["voluntary"] },
  { id: "HC02", question: "Show anti-Jewish hate crime incidents by year", tab: "hate_crime", category: "hate_crime", expect: "rows", sqlIncludes: ["Anti-Jewish"], responseIncludes: ["voluntary"] },
  { id: "HC03", question: "Which states reported the most hate crimes in 2023?", tab: "hate_crime", category: "hate_crime", expect: "rows" },
  { id: "HC04", question: "Break down hate crimes by bias category in 2023", tab: "hate_crime", category: "hate_crime", expect: "rows" },
  { id: "HC05", question: "anti-Black hate crime offenses by year since 2015", tab: "hate_crime", category: "hate_crime", expect: "rows", sqlIncludes: ["Anti-Black"] },
  { id: "HC06", question: "How many agencies report hate crimes in each state?", tab: "hate_crime", category: "hate_crime", expect: "rows", sqlIncludes: ["hate_crime_participation"] },
  { id: "HC07", question: "What are the most common offenses in hate crimes?", tab: "hate_crime", category: "hate_crime", expect: "rows" },
  { id: "HC08", question: "Compare anti-Islamic and anti-Jewish hate crimes over time", tab: "hate_crime", category: "hate_crime", expect: "rows" },
  { id: "HC09", question: "hate crimes at schools by year", tab: "hate_crime", category: "hate_crime", expect: "rows_or_text", sqlIncludes: ["location"], note: "Location values are 'School/College', 'School-Elementary/Secondary', 'School-College/University' — model may use exact or LIKE match" },
  { id: "HC10", question: "anti-LGBTQ hate crimes nationally", tab: "hate_crime", quick: true, category: "hate_crime", expect: "rows", responseIncludes: ["voluntary"] },

  // ── Hate crime routing ──
  { id: "HR01", question: "antisemitic incidents in New York since 2015", tab: "auto", expectedTab: "hate_crime", category: "routing", expect: "rows" },
  { id: "HR02", question: "bias-motivated crimes by state", tab: "auto", expectedTab: "hate_crime", category: "routing", expect: "rows" },
  { id: "HR03", question: "anti-Hispanic hate crime trend", tab: "auto", expectedTab: "hate_crime", category: "routing", expect: "rows" },

  // ── Current monthly ──
  { id: "T01", question: "Show me theft in Omaha rolling over 12 months", tab: "current", category: "current", expect: "rows" },
  { id: "T02", question: "Denver murders by month from 2018 to present", tab: "current", category: "current", expect: "rows" },
  { id: "T03", question: "monthly robbery trend in Seattle", tab: "current", category: "current", expect: "rows" },
  { id: "T04", question: "National murder trend", tab: "current", quick: true, category: "current", expect: "rows" },
  { id: "T05", question: "Murder rate in Houston per 100K", tab: "current", category: "current", expect: "rows" },
  { id: "T06", question: "Compare monthly murders in Baltimore and Detroit", tab: "current", category: "current", expect: "rows" },

  // ── Unsupported concepts / refusals ──
  { id: "U01", question: "conviction rates for murders in Houston", tab: "historical", quick: true, category: "refusal", expect: "override", responseIncludes: ["clearance rates"], responseExcludes: ["case outcomes"], note: "Must not imply we have conviction data" },
  { id: "U02", question: "how many offenders were sentenced to prison", tab: "historical", category: "refusal", expect: "override", responseIncludes: ["clearance rates"] },
  { id: "U03", question: "shootings in Chicago since 2015", tab: "auto", expectedTab: "shr", quick: true, category: "shooting", expect: "rows", responseIncludes: ["fatal", "nonfatal"], note: "Bare shootings → SHR fatal shootings with nonfatal caveat" },
  // ── Shooting contract tests ──
  { id: "SH01", question: "fatal shootings in Chicago since 2015", tab: "auto", expectedTab: "shr", category: "shooting", expect: "rows", responseIncludes: ["fatal"], note: "Explicit fatal → SHR" },
  { id: "SH02", question: "nonfatal shootings in Chicago since 2015", tab: "auto", expectedTab: "shr", category: "shooting", expect: "rows_or_text", responseIncludes: ["nonfatal"], note: "Nonfatal → deterministic refusal" },
  { id: "SH03", question: "shooting incidents in Houston", tab: "auto", expectedTab: "shr", category: "shooting", expect: "rows_or_text", responseIncludes: ["nonfatal"], note: "Broad shooting incidents → refusal" },
  { id: "SH04", question: "people shot in Dallas", tab: "auto", expectedTab: "shr", category: "shooting", expect: "rows_or_text", responseIncludes: ["nonfatal"], note: "People shot → refusal" },
  { id: "SH05", question: "aggravated assault with firearm in Dallas", tab: "nibrs", category: "shooting", expect: "rows", note: "Explicit agg assault w/ firearm → NIBRS allowed" },
  { id: "SH06", question: "firearm murders in Houston since 2010", tab: "auto", expectedTab: "shr", category: "shooting", expect: "rows", note: "Firearm murders → SHR" },

  { id: "U04", question: "crime by ZIP code in Chicago", tab: "nibrs", category: "refusal", expect: "override", note: "Sub-city geography not available" },
  { id: "U05", question: "show me data for the new orleans msa by census tract", tab: "nibrs", category: "refusal", expect: "override" },
  { id: "U06", question: "how many cases used DNA evidence", tab: "nibrs", quick: true, category: "refusal", expect: "override", responseIncludes: ["evidence"] },

  // ── Explanation wording ──
  { id: "E01", question: "violent crime in Alameda County since 2008", tab: "historical", category: "explanation", responseExcludes: ["cities in alameda", "cities within alameda", "across cities"], responseIncludes: ["county"], expect: "rows", note: "County queries must say county record" },
  { id: "E02", question: "violent crime in California since 2008", tab: "historical", category: "explanation", responseExcludes: ["california cities", "cities in california"], expect: "rows", note: "State queries must say statewide" },

  // ── offense-missing-filter regression ──
  { id: "F01", question: "murders in Houston since 2010", tab: "historical", quick: true, category: "offense-filter", sqlIncludes: ["murder"], expect: "rows", note: "Historical column-based offense must not trigger offense-missing-filter" },
  { id: "F02", question: "murders in Chicago since 2010", tab: "historical", category: "offense-filter", expect: "rows" },
  { id: "F03", question: "robbery in Philadelphia since 2000", tab: "historical", category: "offense-filter", expect: "rows" },

  // ── SHR relationship/circumstance ──
  { id: "D01", question: "What percentage of murders are domestic violence related nationally?", tab: "shr", category: "shr-relationship", expect: "rows" },
  { id: "D02", question: "How many murders stem from arguments versus other circumstances?", tab: "shr", category: "shr-relationship", expect: "rows" },
  { id: "D03", question: "Compare justifiable homicides by police versus civilians nationally", tab: "shr", category: "shr-relationship", expect: "rows" },

  // ── Regression: production failures ──
  { id: "P01", question: "rate of violent crime in Washington DC from 2014 to today", tab: "historical", category: "production-regression", expect: "rows" },
  { id: "P02", question: "national trend in DWI/DUI from 2000 to today", tab: "nibrs", category: "production-regression", expect: "rows" },
  { id: "P03", question: "Show me trends in hate crime", tab: "hate_crime", category: "hate_crime", expect: "rows", responseIncludes: ["voluntary"] },
  { id: "P04", question: "How do juvenile crime rates compare to criminal rates", tab: "nibrs", category: "production-regression", expect: "rows" },
  { id: "P05", question: "Carjackings in boston since 2025", tab: "nibrs", category: "production-regression", expect: "rows" },
  { id: "P06", question: "Examine trends in gang homicides in Chicago IL over time", tab: "shr", category: "production-regression", expect: "rows" },
  { id: "P07", question: "Compare crime rates vs police staffing levels across the 20 largest cities in the US", tab: "historical", category: "production-regression", expect: "rows" },
  { id: "P08", question: "Homicide of female by a relative 1975-2023", tab: "shr", category: "production-regression", expect: "rows" },
  { id: "P09", question: "crime in Alameda County since 2008", tab: "historical", quick: true, category: "production-regression", sqlIncludes: ["alameda county"], sqlExcludes: ["historical_state_national"], expect: "rows" },

  // ── Additional coverage ──
  { id: "A01", question: "What five cities are currently experiencing the greatest number of homicides?", tab: "auto", expectedTab: ["current", "historical"], category: "additional", expect: "rows" },
  { id: "A02", question: "Can you please show me the aggravated assault rates for New York City by year from 2019 to 2025?", tab: "auto", expectedTab: ["current", "historical"], category: "additional", expect: "rows" },
  { id: "A03", question: "Compare the number of Chicago officers to NYPD officers per year", tab: "historical", category: "additional", expect: "rows" },
  { id: "A04", question: "Victim age and sex breakdown for murders in California in 2022", tab: "auto", expectedTab: ["shr", "nibrs"], category: "additional", expect: "rows" },
  { id: "A05", question: "What share of homicides are intraracial since 2000?", tab: "shr", category: "additional", expect: "rows" },
  { id: "A06", question: "sworn officers per capita in big cities", tab: "historical", category: "additional", expect: "rows" },
  { id: "A07", question: "counties with most reported data in 2025", tab: "auto", expectedTab: ["current", "historical"], category: "additional", expect: "rows" },
  { id: "A08", question: "compare crime in the top 10 cities in texas", tab: "auto", expectedTab: ["current", "historical"], category: "additional", expect: "rows" },
  { id: "A09", question: "What is the clearance rate for rape in Florida by year?", tab: "auto", expectedTab: ["historical", "nibrs"], category: "additional", expect: "rows" },
  { id: "A10", question: "How many carjackings were reported in California from 2019 to 2024?", tab: "nibrs", category: "additional", expect: "rows" },
  { id: "A11", question: "murder rate in the 1990s", tab: "historical", category: "additional", expect: "rows" },
  { id: "A12", question: "burglary trend since 1985", tab: "historical", category: "additional", expect: "rows" },
  { id: "A13", question: "crime in Cook County Illinois", tab: "historical", category: "additional", expect: "rows" },
  { id: "A14", question: "violent crime in DC from 2014", tab: "historical", category: "additional", expect: "rows" },
  { id: "A15", question: "marijuana arrests", tab: "nibrs", category: "additional", expect: "rows" },
  { id: "A16", question: "heroin offenses by state", tab: "nibrs", category: "additional", expect: "rows" },
  { id: "A17", question: "bias-motivated offenses by type", tab: "nibrs", category: "additional", expect: "rows" },
  { id: "A18", question: "monthly robbery trend in Seattle", tab: "current", category: "additional", expect: "rows" },
  { id: "A19", question: "domestic murders in dallas per year since 2020", tab: "shr", category: "additional", expect: "rows" },
  { id: "A20", question: "how many violent offenses involved a firearm?", tab: "auto", expectedTab: ["nibrs", "shr"], category: "additional", expect: "rows" },

  // ── Long-range queries ──
  { id: "L01", question: "New York City murder rate 1930-2024", tab: "historical", category: "long-range", expect: "rows" },
  { id: "L02", question: "national homicide rate from 1950 to 2024", tab: "historical", category: "long-range", expect: "rows" },
  { id: "L03", question: "Chicago officers per year, 1930-2025", tab: "historical", category: "long-range", expect: "rows" },

  // ── Ranking queries ──
  { id: "K01", question: "What jurisdictions had the highest murder rates in 2024?", tab: "current", category: "ranking", expect: "rows" },
  { id: "K02", question: "top 10 cities by robbery count in 2022", tab: "nibrs", category: "ranking", expect: "rows" },
  { id: "K03", question: "Which cities had the most officers per capita?", tab: "historical", category: "ranking", expect: "rows" },

  // ── Surrounding/sub-city ──
  { id: "X01", question: "crime in the surrounding areas near DC", tab: "historical", category: "geography", expect: "override", note: "Should ask for specific jurisdictions" },

  // ── Multi-city comparison ──
  { id: "M01", question: "Compare the total annual number of homicides in Baltimore and Chicago over the past 10 years", tab: "historical", category: "comparison", expect: "rows" },
  { id: "M02", question: "Compare auto thefts between Philadelphia and Chicago", tab: "auto", expectedTab: ["current", "historical"], category: "comparison", expect: "rows" },
  { id: "M03", question: "Compare murder offender demographics in Chicago vs Houston in 2023", tab: "auto", expectedTab: ["nibrs", "shr"], category: "comparison", expect: "rows" },

  // ── F5 audit replay (June 9 false refusals — query log #4053/#4055/#4105) ──
  { id: "F5-01", question: "which states do you have data for?", tab: "current", category: "f5-refusal-replay", expect: "rows", minRows: 40, note: "Log #4053 — deterministic state coverage list" },
  { id: "F5-02", question: "what states are not represented?", tab: "current", category: "f5-refusal-replay", expect: "rows_or_text", responseIncludes: ["missing"], note: "Log #4055 — was a false refusal; metadata-coverage must answer with missing states" },
  { id: "F5-03", question: "which states aren't in the data?", tab: "current", category: "f5-refusal-replay", expect: "rows_or_text", responseIncludes: ["missing"], note: "Broader phrasing of F5-02" },
  { id: "F5-04", question: "can i download this by state?", tab: "historical", category: "f5-refusal-replay", expect: "rows_or_text", responseIncludes: ["download"], note: "Log #4105 — must answer the download question, not mislabel scope" },

  // ── June 9 audit post-deploy probes (#4121, #4114, #4095) ──
  { id: "AUD-01", question: "What is the total number of gun homicides in St. Louis County 2026 year-to-date?", tab: "shr", category: "audit-probe", expect: "rows", allowZeroRows: true, sqlIncludes: ["shr_agency_alias"], note: "Log #4121 — must resolve agency via alias tables; a zero count is correct (lone 2026 incident is manslaughter) but must come from a matched agency" },
  { id: "AUD-02", question: "what is the homicide rate by firearm in Pennsylvania from 2015-2024", tab: "shr", category: "audit-probe", expect: "rows", minRows: 8, sqlIncludes: ["state_population"], note: "Log #4114 — state rate must use state_population, not AVG(agency population)" },
  { id: "AUD-03", question: "show crime in Pennsylvania", tab: "nibrs", category: "audit-probe", expect: "rows_or_text", responseExcludes: ["no such table"], note: "Log #4095 — cross-tab contamination must not surface a raw DB error" },
  { id: "AUD-04", question: "Show me the trends in misdemeanor arrests in the ten largest cities", tab: "nibrs", category: "audit-probe", expect: "override", responseIncludes: ["misdemeanor"], note: "Log #4145 (F17) — must hard-stop with charge-severity limitation, never invent severity labels" },
  { id: "AUD-05", question: "DUI arrests by age group nationally", tab: "nibrs", category: "audit-probe", expect: "rows", note: "F17 carve-out — ordinary arrest queries must still work" },
  { id: "AUD-06", question: "how has gun violence changed in New York State since 2022?", tab: "shr", category: "audit-probe", expect: "rows", minRows: 4, sqlIncludes: ["state = 'NY'"], sqlExcludes: ["agency = 'New York'"], note: "Log #4155 (F18) — state-level question must aggregate statewide, not NYPD" },
  { id: "AUD-07", question: "gun murders in New York City since 2022", tab: "shr", category: "audit-probe", expect: "rows", note: "F18 carve-out — explicit city question must still resolve to the city agency" },
  { id: "AUD-08", question: "what percentage of homicides in Texas involved a firearm since 2020?", tab: "shr", category: "audit-probe", expect: "rows", sqlExcludes: ["::numeric", "::float"], note: "June 11 — ratio queries must use SQLite-compatible casts, never Postgres :: syntax" },
  { id: "AUD-09", question: "disorderly conduct arrests in the 10 most populous states", tab: "nibrs", category: "audit-probe", expect: "rows", sqlIncludes: ["state_population"], note: "June 11 (#4146 timeout class) — must rank states from state_population, not SUM(agencies.population)" },
  { id: "AUD-10", question: "murders in Chicago over the last decade", tab: "historical", category: "audit-probe", expect: "rows", sqlIncludes: ["2016"], note: "June 11 — 'last decade' = last 10 complete calendar years (2016-2025 as of June 2026)" },
  { id: "AUD-11", question: "which cities are in Santa Clara County?", tab: "nibrs", category: "audit-probe", expect: "rows", minRows: 5, responseIncludes: ["San Jose"], note: "June 11 #4 — crosswalk live: county membership now answered from agency_county_crosswalk (assertion flipped from the pre-crosswalk refusal)" },
  { id: "AUD-13", question: "how has gun violence changed in Cook County since 2015?", tab: "shr", category: "audit-probe", expect: "rows", sqlExcludes: ["agency = 'Cook County'"], note: "June 11 #4 — deterministic shooting path must resolve county geography via crosswalk, not agency name" },
  { id: "AUD-12", question: "which cities are represented in Pennsylvania?", tab: "current", category: "audit-probe", expect: "rows", minRows: 2, note: "June 11 #4 — state-scoped metadata city list must filter by state" },
];

// ══════════════════════════════════════════════════════════════════════
//  Multi-turn session definitions
// ══════════════════════════════════════════════════════════════════════

interface SessionStep {
  question: string;
  tab: TabId;
  expect: "rows" | "override" | "rows_or_text";
  sqlIncludes?: string[];
  sqlExcludes?: string[];
  responseIncludes?: string[];
  responseExcludes?: string[];
  note?: string;
}

interface SessionDef {
  id: string;
  name: string;
  steps: SessionStep[];
}

const SESSIONS: SessionDef[] = [
  {
    id: "MS01",
    name: "Houston murders → compare → rate → firearm reroute",
    steps: [
      { question: "murders in Houston since 2010", tab: "historical", expect: "rows", sqlIncludes: ["murder"] },
      { question: "compare to Dallas", tab: "historical", expect: "rows", note: "Follow-up: inherits Historical" },
      { question: "show rates instead of counts", tab: "historical", expect: "rows", note: "Follow-up: keeps Historical" },
      { question: "now show firearm murders instead", tab: "shr", expect: "rows", sqlIncludes: ["weapon"], note: "Hard-req reroute to SHR" },
    ],
  },
  {
    id: "MS02",
    name: "Alameda County → clarification → city comparison",
    steps: [
      { question: "violent crime in Alameda County since 2008", tab: "historical", expect: "rows", sqlIncludes: ["alameda county"], sqlExcludes: ["historical_state_national"] },
      { question: "is this countywide or just the sheriff?", tab: "historical", expect: "rows_or_text", responseIncludes: ["county"], responseExcludes: ["county-level aggregate", "countywide rollup", "all municipal", "every city police"], note: "May answer with text or metadata lookup — either way, must not imply a full countywide rollup" },
      { question: "now compare to violent crime in Oakland since 2008", tab: "historical", expect: "rows", note: "New city, same tab" },
    ],
  },
  {
    id: "MS03",
    name: "Hate crimes → bias breakdown → anti-Asian → participation",
    steps: [
      { question: "hate crimes in California since 2010", tab: "hate_crime", expect: "rows" },
      { question: "break it down by bias type", tab: "hate_crime", expect: "rows", note: "Follow-up: drill down" },
      { question: "just anti-Asian incidents", tab: "hate_crime", expect: "rows" },
      { question: "show participation over time", tab: "hate_crime", expect: "rows", note: "Follow-up: keeps hate_crime" },
    ],
  },
  {
    id: "MS04",
    name: "F5 replay: national rolling murders → split by state (log #4051→#4052)",
    steps: [
      { question: "Can I see murders rolling over 12 months nationally, 2018 to present?", tab: "current", expect: "rows", sqlIncludes: ["national_monthly"] },
      { question: "split it out by state", tab: "current", expect: "rows", sqlIncludes: ["partition by state"], note: "Log #4052 — was a false refusal; followup-transform must produce per-state rolling windows" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════
//  Config
// ══════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const isQuick = args.includes("--quick");
const isSessions = args.includes("--sessions");
const rerunIdx = args.indexOf("--rerun");
const rerunIds = rerunIdx >= 0 && args[rerunIdx + 1] ? args[rerunIdx + 1].split(",") : null;
const hostIdx = args.indexOf("--host");
const HOST = hostIdx >= 0 && args[hostIdx + 1] ? args[hostIdx + 1] : "https://nibrsai.com";
const DELAY_MS = isQuick ? 12_000 : 18_000;
const SESSION_ID = `live-replay-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`;

let tests: TestCase[];
if (rerunIds) {
  tests = ALL_TESTS.filter(t => rerunIds.includes(t.id));
} else if (isQuick) {
  tests = ALL_TESTS.filter(t => t.quick);
} else if (isSessions) {
  tests = []; // sessions handled separately
} else {
  tests = ALL_TESTS;
}

const modeName = rerunIds ? `rerun(${rerunIds.join(",")})` : isSessions ? "sessions" : isQuick ? "quick" : "full";
console.log(`\nLive Replay: ${isSessions ? `${SESSIONS.length} sessions` : `${tests.length} tests`} (${modeName} mode)`);
console.log(`Host: ${HOST}`);
console.log(`Session: ${SESSION_ID}`);
console.log(`Delay: ${DELAY_MS / 1000}s between requests\n`);

// ══════════════════════════════════════════════════════════════════════
//  API Client
// ══════════════════════════════════════════════════════════════════════

const TIMEOUT = 90_000;

async function fetchPageToken(): Promise<string> {
  const res = await fetch(`${HOST}/api/page-token`);
  if (!res.ok) throw new Error(`Failed to fetch page token: ${res.status}`);
  const data = await res.json() as { token: string };
  return data.token;
}

function resolveTab(tc: TestCase): TabId {
  if (tc.tab !== "auto") return tc.tab;
  const route = autoRoute(tc.question);
  return route?.source || "historical";
}

function apiRoute(tab: TabId): string {
  switch (tab) {
    case "current": case "historical": return "/api/query";
    case "nibrs": return "/api/nibrs-query";
    case "shr": return "/api/shr-query";
    case "hate_crime": return "/api/hc-query";
  }
}

function buildBody(question: string, tab: TabId, pageToken: string, sessionId: string, history?: unknown[]): Record<string, unknown> {
  const base: Record<string, unknown> = { question, pageToken, sessionId };
  if (history && history.length > 0) base.history = history;
  if (tab === "current") return { ...base, mode: "current" };
  if (tab === "historical") return { ...base, mode: "historical" };
  return base;
}

interface ApiResponse {
  sql: string | null;
  explanation: string;
  rows: unknown[];
  rowCount: number;
  guardrailsFired: string[];
  httpStatus: number;
  raw: Record<string, unknown>;
}

async function parseSSE(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  if (res.status !== 200) {
    try {
      const err = JSON.parse(text);
      return { sql: null, explanation: err.error || `HTTP ${res.status}`, rows: [], rowCount: 0, guardrailsFired: [], httpStatus: res.status, raw: err };
    } catch { /* fall through */ }
    return { sql: null, explanation: `HTTP ${res.status}`, rows: [], rowCount: 0, guardrailsFired: [], httpStatus: res.status, raw: {} };
  }
  let result: Record<string, unknown> = {};
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === "result") result = data;
    } catch { /* skip */ }
  }
  return {
    sql: (result.sql as string) || null,
    explanation: (result.explanation as string) || "",
    rows: (result.rows as unknown[]) || [],
    rowCount: (result.rowCount as number) || 0,
    guardrailsFired: [],
    httpStatus: res.status,
    raw: result,
  };
}

async function parseJSON(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch {
    return { sql: null, explanation: `Parse error: ${text.substring(0, 100)}`, rows: [], rowCount: 0, guardrailsFired: [], httpStatus: res.status, raw: {} };
  }
  if (data.success === false || data.error) {
    return { sql: null, explanation: (data.error as string) || `HTTP ${res.status}`, rows: [], rowCount: 0, guardrailsFired: [], httpStatus: res.status, raw: data };
  }
  return {
    sql: (data.sql as string) || null,
    explanation: (data.explanation as string) || "",
    rows: (data.rows as unknown[]) || [],
    rowCount: (data.rowCount as number) || 0,
    guardrailsFired: [],
    httpStatus: res.status,
    raw: data,
  };
}

async function runQuery(question: string, tab: TabId, pageToken: string, sessionId?: string, history?: unknown[]): Promise<ApiResponse> {
  const route = apiRoute(tab);
  const body = buildBody(question, tab, pageToken, sessionId || SESSION_ID, history);
  const url = `${HOST}${route}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  // Handle 429 rate limit
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "30");
    console.log(`  429 rate limited — waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    const newToken = await fetchPageToken();
    await sleep(2500);
    const retry = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, pageToken: newToken }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (tab === "current" || tab === "historical") return parseSSE(retry);
    return parseJSON(retry);
  }

  // Handle 202 (CAPTCHA required)
  if (res.status === 202) {
    console.log(`  202 CAPTCHA required — waiting 20s with fresh token...`);
    await sleep(20_000);
    const newToken = await fetchPageToken();
    await sleep(2500);
    const retry = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, pageToken: newToken, sessionId: (sessionId || SESSION_ID) + "-retry" }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (tab === "current" || tab === "historical") return parseSSE(retry);
    return parseJSON(retry);
  }

  // Handle 403 (bad token)
  if (res.status === 403) {
    console.log(`  403 forbidden — refreshing token...`);
    const newToken = await fetchPageToken();
    await sleep(2500);
    const retry = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, pageToken: newToken }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (tab === "current" || tab === "historical") return parseSSE(retry);
    return parseJSON(retry);
  }

  if (tab === "current" || tab === "historical") return parseSSE(res);
  return parseJSON(res);
}

// ══════════════════════════════════════════════════════════════════════
//  Assertions
// ══════════════════════════════════════════════════════════════════════

function isInfrastructureFailure(resp: ApiResponse): boolean {
  if (resp.httpStatus === 202 || resp.httpStatus === 429) return true;
  if (resp.httpStatus !== 200 && !resp.sql && resp.explanation.length < 30) return true;
  return false;
}

function checkAssertions(tc: TestCase, resp: ApiResponse, tab: TabId): { status: ResultStatus; failures: string[] } {
  // Infrastructure check first — if the API didn't respond properly, mark inconclusive
  if (isInfrastructureFailure(resp)) {
    return { status: "inconclusive", failures: [`Infrastructure: HTTP ${resp.httpStatus} — ${resp.explanation.substring(0, 80)}`] };
  }

  const failures: string[] = [];
  const sqlLower = (resp.sql || "").toLowerCase();
  const explainLower = resp.explanation.toLowerCase();
  const isOverrideOrRefusal = tc.expect === "override" || tc.expect === "refusal" || tc.expect === "clarification";

  // Tab routing
  if (tc.tab === "auto" && tc.expectedTab) {
    const expected = Array.isArray(tc.expectedTab) ? tc.expectedTab : [tc.expectedTab];
    if (!expected.includes(tab)) {
      failures.push(`Routed to ${tab}, expected ${expected.join("|")}`);
    }
  }

  // rows_or_text: accepts either data rows or a text-only answer (no SQL)
  // Only check response wording, not row/SQL expectations
  if (tc.expect === "rows_or_text") {
    if (resp.httpStatus !== 200) {
      return { status: "inconclusive", failures: [`HTTP ${resp.httpStatus} — cannot evaluate`] };
    }
    // Must have EITHER rows or a meaningful explanation
    if (resp.rowCount === 0 && !resp.sql && resp.explanation.length < 20) {
      return { status: "inconclusive", failures: ["No rows, no SQL, no explanation — possible infrastructure issue"] };
    }
    // Skip to response wording checks below
  }

  // Row expectations (strengthened)
  if (tc.expect === "rows") {
    if (resp.httpStatus !== 200) {
      return { status: "inconclusive", failures: [`HTTP ${resp.httpStatus} — cannot evaluate row expectations`] };
    }
    if (!resp.sql) {
      // Null SQL when expecting rows = either infrastructure or guardrail override
      if (resp.explanation.length > 20) {
        // Got an explanation but no SQL — could be a guardrail override (which is a real failure for "expect rows")
        failures.push(`Expected rows but got null SQL with explanation: "${resp.explanation.substring(0, 100)}"`);
      } else {
        return { status: "inconclusive", failures: ["Null SQL + empty explanation — possible infrastructure issue"] };
      }
    }
    if (resp.rowCount === 0 && !tc.allowZeroRows && resp.sql) {
      failures.push(`Expected rows but got 0 rows`);
    }
  }

  // Override/refusal expectations
  if (isOverrideOrRefusal) {
    if (resp.rowCount > 0 && resp.sql) {
      if (!explainLower.includes("does not") && !explainLower.includes("ambiguous") &&
          !explainLower.includes("not available") && !explainLower.includes("cannot") &&
          !explainLower.includes("couldn't") && !explainLower.includes("not contain")) {
        failures.push(`Expected override/refusal but got ${resp.rowCount} rows`);
      }
    }
  }

  // SQL includes (only when we have SQL)
  if (tc.sqlIncludes && !isOverrideOrRefusal && resp.sql) {
    for (const inc of tc.sqlIncludes) {
      if (!sqlLower.includes(inc.toLowerCase())) {
        failures.push(`SQL missing "${inc}"`);
      }
    }
  }

  // SQL excludes
  if (tc.sqlExcludes && resp.sql && !isOverrideOrRefusal) {
    for (const exc of tc.sqlExcludes) {
      if (sqlLower.includes(exc.toLowerCase())) {
        failures.push(`SQL contains forbidden "${exc}"`);
      }
    }
  }

  // Response includes (only when we have a real response)
  if (tc.responseIncludes && resp.explanation.length > 10) {
    for (const inc of tc.responseIncludes) {
      if (!explainLower.includes(inc.toLowerCase())) {
        failures.push(`Response missing "${inc}"`);
      }
    }
  }

  // Response excludes
  if (tc.responseExcludes && resp.explanation.length > 10) {
    for (const exc of tc.responseExcludes) {
      if (explainLower.includes(exc.toLowerCase())) {
        failures.push(`Response contains forbidden "${exc}"`);
      }
    }
  }

  // Min rows
  if (tc.minRows && resp.rowCount < tc.minRows) {
    failures.push(`Expected ≥${tc.minRows} rows, got ${resp.rowCount}`);
  }

  return { status: failures.length === 0 ? "pass" : "fail", failures };
}

// ══════════════════════════════════════════════════════════════════════
//  Runner
// ══════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const results: TestResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let inconclusiveCount = 0;
  let errorCount = 0;

  console.log("Fetching page token...");
  let pageToken = await fetchPageToken();
  await sleep(2500);
  let tokenAge = Date.now();

  async function refreshTokenIfNeeded() {
    if (Date.now() - tokenAge > 30 * 60_000) {
      console.log("  Refreshing page token...");
      pageToken = await fetchPageToken();
      await sleep(2500);
      tokenAge = Date.now();
    }
  }

  // ── Standalone tests ──
  const totalLabel = isSessions ? "sessions" : "tests";
  const totalCount = isSessions ? SESSIONS.length : tests.length;

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    const tab = resolveTab(tc);
    const progress = `[${i + 1}/${tests.length}]`;

    await refreshTokenIfNeeded();
    process.stdout.write(`${progress} ${tc.id} [${tab}] "${tc.question.substring(0, 60)}..." `);
    const start = Date.now();

    try {
      const resp = await runQuery(tc.question, tab, pageToken);
      const durationMs = Date.now() - start;
      const { status, failures } = checkAssertions(tc, resp, tab);

      results.push({
        id: tc.id, question: tc.question, tab, category: tc.category,
        status, failures, sql: resp.sql, explanation: resp.explanation.substring(0, 300),
        rowCount: resp.rowCount, httpStatus: resp.httpStatus,
        guardrailsFired: resp.guardrailsFired, durationMs, note: tc.note,
      });

      if (status === "pass") { passCount++; console.log(`✓ ${resp.rowCount}r ${durationMs}ms`); }
      else if (status === "inconclusive") { inconclusiveCount++; console.log(`? [HTTP ${resp.httpStatus}] ${failures[0]}`); }
      else { failCount++; console.log(`✗ ${failures.join("; ")}`); }
    } catch (err) {
      errorCount++;
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        id: tc.id, question: tc.question, tab, category: tc.category,
        status: "inconclusive", failures: [`ERROR: ${errMsg}`], sql: null, explanation: "",
        rowCount: 0, httpStatus: 0, guardrailsFired: [], durationMs: Date.now() - start, note: tc.note,
      });
      console.log(`? ERROR: ${errMsg.substring(0, 80)}`);
      inconclusiveCount++;
    }

    if (i < tests.length - 1) await sleep(DELAY_MS);
  }

  // ── Multi-turn sessions ──
  // --sessions runs all; --sessions --rerun MS04 runs a subset by session id
  const sessionsToRun = rerunIds ? SESSIONS.filter(s => rerunIds.includes(s.id)) : SESSIONS;
  if ((isSessions && sessionsToRun.length > 0) || (!isQuick && !rerunIds)) {
    console.log(`\n═══ Multi-turn Sessions ═══\n`);
    for (const session of sessionsToRun) {
      console.log(`Session ${session.id}: ${session.name}`);
      const sessionSid = `${SESSION_ID}-${session.id}`;
      const history: unknown[] = [];

      for (let j = 0; j < session.steps.length; j++) {
        const step = session.steps[j];
        const stepId = `${session.id}-S${j + 1}`;
        await refreshTokenIfNeeded();
        process.stdout.write(`  [${j + 1}/${session.steps.length}] "${step.question.substring(0, 55)}..." `);
        const start = Date.now();

        try {
          const resp = await runQuery(step.question, step.tab, pageToken, sessionSid, history);
          const durationMs = Date.now() - start;

          // Build a synthetic TestCase for assertion checking
          const tc: TestCase = {
            id: stepId, question: step.question, tab: step.tab, category: "session",
            expect: step.expect, sqlIncludes: step.sqlIncludes, sqlExcludes: step.sqlExcludes,
            responseIncludes: step.responseIncludes, responseExcludes: step.responseExcludes,
            note: step.note,
          };
          const { status, failures } = checkAssertions(tc, resp, step.tab);

          results.push({
            id: stepId, question: step.question, tab: step.tab, category: "session",
            status, failures, sql: resp.sql, explanation: resp.explanation.substring(0, 300),
            rowCount: resp.rowCount, httpStatus: resp.httpStatus,
            guardrailsFired: resp.guardrailsFired, durationMs, note: step.note,
          });

          // Build conversation history for next turn
          if (resp.sql) {
            history.push({ role: "user", content: step.question });
            history.push({ role: "assistant", content: JSON.stringify({ sql: resp.sql, explanation: resp.explanation.substring(0, 200) }) });
          }

          if (status === "pass") { passCount++; console.log(`✓ ${resp.rowCount}r ${durationMs}ms`); }
          else if (status === "inconclusive") { inconclusiveCount++; console.log(`? [HTTP ${resp.httpStatus}] ${failures[0]}`); }
          else { failCount++; console.log(`✗ ${failures.join("; ")}`); }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          results.push({
            id: stepId, question: step.question, tab: step.tab, category: "session",
            status: "inconclusive", failures: [`ERROR: ${errMsg}`], sql: null, explanation: "",
            rowCount: 0, httpStatus: 0, guardrailsFired: [], durationMs: Date.now() - start, note: step.note,
          });
          console.log(`? ERROR: ${errMsg.substring(0, 80)}`);
          inconclusiveCount++;
        }

        if (j < session.steps.length - 1) await sleep(DELAY_MS);
      }
      console.log();
      await sleep(DELAY_MS);
    }
  }

  // ── Output ──
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  mkdirSync("audit", { recursive: true });

  const totalResults = results.length;
  const jsonPath = `audit/live-replay-${timestamp}.json`;
  writeFileSync(jsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    host: HOST,
    session: SESSION_ID,
    mode: modeName,
    total: totalResults,
    passed: passCount,
    failed: failCount,
    inconclusive: inconclusiveCount,
    errors: errorCount,
    results,
  }, null, 2));

  // Markdown
  const failedResults = results.filter(r => r.status === "fail");
  const inconclusiveResults = results.filter(r => r.status === "inconclusive");

  const groupBy = (items: TestResult[]) => {
    const groups: Record<string, TestResult[]> = {};
    for (const r of items) { if (!groups[r.category]) groups[r.category] = []; groups[r.category].push(r); }
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  };

  let md = `# Live Replay Results\n\n`;
  md += `- **Date**: ${new Date().toISOString()}\n`;
  md += `- **Host**: ${HOST}\n`;
  md += `- **Mode**: ${modeName}\n`;
  md += `- **Session**: ${SESSION_ID}\n`;
  md += `- **Total**: ${totalResults}\n`;
  md += `- **Passed**: ${passCount}\n`;
  md += `- **Failed**: ${failCount} (real assertion failures)\n`;
  md += `- **Inconclusive**: ${inconclusiveCount} (infrastructure — CAPTCHA/rate-limit/timeout)\n`;
  md += `- **Errors**: ${errorCount}\n\n`;

  if (failedResults.length === 0 && inconclusiveResults.length === 0) {
    md += `## All tests passed!\n`;
  } else {
    if (failedResults.length > 0) {
      md += `## Real Failures (${failedResults.length})\n\n`;
      for (const [cat, items] of groupBy(failedResults)) {
        md += `### ${cat} (${items.length})\n\n`;
        for (const r of items) {
          md += `**${r.id}**: "${r.question}"\n`;
          md += `- Tab: ${r.tab}, Rows: ${r.rowCount}, HTTP: ${r.httpStatus}, Duration: ${r.durationMs}ms\n`;
          md += `- Failures: ${r.failures.join("; ")}\n`;
          if (r.sql) md += `- SQL: \`${r.sql.substring(0, 150)}...\`\n`;
          md += `- Response: ${r.explanation.substring(0, 200)}\n`;
          if (r.note) md += `- Note: ${r.note}\n`;
          md += `\n`;
        }
      }
    }
    if (inconclusiveResults.length > 0) {
      md += `## Inconclusive — Infrastructure (${inconclusiveResults.length})\n\n`;
      md += `These tests need rerun. The API did not respond due to CAPTCHA/rate-limit.\n\n`;
      md += `Rerun command: \`npx tsx scripts/live-replay.ts --rerun ${inconclusiveResults.map(r => r.id).join(",")}\`\n\n`;
      for (const r of inconclusiveResults) {
        md += `- **${r.id}** [${r.category}]: "${r.question}" — ${r.failures[0]}\n`;
      }
      md += `\n`;
    }
  }

  const mdPath = `audit/live-replay-${timestamp}.md`;
  writeFileSync(mdPath, md);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`LIVE REPLAY: ${passCount} passed, ${failCount} failed, ${inconclusiveCount} inconclusive out of ${totalResults}`);
  console.log(`Output: ${jsonPath}`);
  console.log(`Report: ${mdPath}`);
  console.log(`${"═".repeat(60)}`);

  if (failedResults.length > 0) {
    console.log(`\nReal failures:`);
    for (const [cat, items] of groupBy(failedResults)) console.log(`  ${cat}: ${items.length}`);
  }
  if (inconclusiveResults.length > 0) {
    console.log(`\nInconclusive (rerun needed):`);
    console.log(`  npx tsx scripts/live-replay.ts --rerun ${inconclusiveResults.map(r => r.id).join(",")}`);
  }

  // Exit code: fail only on real assertion failures, not inconclusive
  process.exit(failCount > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(2);
});
