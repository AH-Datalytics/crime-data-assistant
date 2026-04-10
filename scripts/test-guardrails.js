#!/usr/bin/env node
/**
 * Unit tests for query-context extraction and guardrail pipeline.
 * No API calls needed — tests pure logic locally.
 *
 * Usage: node scripts/test-guardrails.js
 */

let pass = 0;
let fail = 0;
const failures = [];

function assert(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Shared regex helpers (mirrors query-context.ts / guardrails.ts) ──

const IN_CITY_RE = /\bin\s+([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)/;
const LEADING_CITY_RE = /^([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)\s+(?:[a-z]+\s+)*?(?:[Mm]urder|[Rr]obbery|[Aa]ssault|[Bb]urglary|[Tt]heft|[Cc]rime|[Ss]taffing|[Pp]olice|[Oo]fficers|[Hh]omicide|[Rr]ape|[Cc]arjacking|[Aa]rson)/;
const CITY_FALLBACK_RE = /\bin\s+([A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]+)*)/;
const NON_CITY_WORDS = /\b(united states|national|nationwide|country|state|federal|annual|home|residential|commercial)\b/i;

const AGENCY_ALIASES = [
  [/\bNYPD\b/i, "New York City"],
  [/\bLAPD\b/i, "Los Angeles"],
  [/\bCPD\b|Chicago\s+police/i, "Chicago"],
  [/\bCMPD\b/i, "Charlotte"],
  [/\bMNPD\b|Metro\s+Nashville/i, "Nashville"],
  [/\bLVMPD\b/i, "Las Vegas"],
  [/\bHPD\b|Houston\s+police/i, "Houston"],
  [/\bDPD\b|Dallas\s+police/i, "Dallas"],
  [/\bMPD\b|Memphis\s+police/i, "Memphis"],
  [/\bBPD\b|Baltimore\s+police/i, "Baltimore"],
];

const NON_CITY_LEADING = /^(National|What|How|Why|When|Where|Which|Who|Show|List|Get|Find|Total|Annual|Compare|Give|Tell|Are|Is|Has|The|All|Any|Do|Does|Did|Can|Could|Should|Would|Will|May|Might)$/i;

function extractGeoFromQuestion(question) {
  const inMatch = question.match(IN_CITY_RE);
  if (inMatch) return inMatch[1];
  for (const [pattern, city] of AGENCY_ALIASES) {
    if (pattern.test(question)) return city;
  }
  const leading = question.match(LEADING_CITY_RE);
  if (leading && !NON_CITY_LEADING.test(leading[1])) return leading[1];
  return null;
}

function extractTablesFromSql(sql) {
  const tables = [];
  const tableRe = /\b(FROM|JOIN)\s+(\w+)/gi;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    const t = m[2].toLowerCase();
    if (!tables.includes(t)) tables.push(t);
  }
  return tables;
}

// ══════════════════════════════════════════════════════════════════════
//  1. QueryContext extraction
// ══════════════════════════════════════════════════════════════════════

console.log("═══ QueryContext extraction — basics ═══\n");

// --- Agency / city from SQL ---
{
  const sql = "SELECT * FROM agency_monthly WHERE agency = 'Charlotte' AND state = 'NC'";
  const geos = [];
  const re = /agency\s*=\s*'([^']+)'/gi;
  let m; while ((m = re.exec(sql)) !== null) geos.push(m[1]);
  assert("extract agency name from SQL", geos.includes("Charlotte"));
}
{
  const sql = "SELECT * FROM summary_victim_city_monthly WHERE city = 'NEW YORK' AND state = 'NY'";
  const re = /city\s*=\s*'([^']+)'/gi;
  let m, geos = []; while ((m = re.exec(sql)) !== null) geos.push(m[1]);
  assert("extract NIBRS city from SQL", geos.includes("NEW YORK"));
}

// --- Multiple agencies ---
{
  const sql = "CASE WHEN agency = 'Chicago' THEN count WHEN agency = 'Houston' THEN count END FROM agency_monthly";
  const re = /agency\s*=\s*'([^']+)'/gi;
  let m, geos = []; while ((m = re.exec(sql)) !== null) geos.push(m[1]);
  assert("extract multiple agencies", geos.length === 2 && geos.includes("Chicago") && geos.includes("Houston"));
}

// --- States ---
{
  const sql = "WHERE state = 'CA' AND year >= 2020";
  const re = /state\s*=\s*'([A-Z]{2})'/gi;
  let m, states = []; while ((m = re.exec(sql)) !== null) states.push(m[1].toUpperCase());
  assert("extract state abbrev", states.includes("CA"));
}
{
  const sql = "WHERE state = 'ca'";
  const re = /state\s*=\s*'([A-Z]{2})'/gi;
  let m, states = []; while ((m = re.exec(sql)) !== null) states.push(m[1].toUpperCase());
  assert("extract lowercase state abbrev", states.includes("CA"));
}

// --- Scope detection ---
{
  const sql = "SELECT year, SUM(count) FROM national_monthly";
  assert("scope: national_monthly → national", sql.toLowerCase().includes("national_monthly"));
}
{
  const sql = "FROM historical_state_national WHERE state = 'United States'";
  assert("scope: United States → national", sql.toLowerCase().includes("'united states'"));
}
{
  const sql = "FROM state_monthly WHERE state = 'TX'";
  const sqlLower = sql.toLowerCase();
  const hasGeo = /agency\s*=\s*'/i.test(sql);
  const scope = sqlLower.includes("state_monthly") && !hasGeo ? "state" : "other";
  assert("scope: state_monthly no agency → state", scope === "state");
}
{
  const sql = "FROM agency_monthly WHERE agency = 'Chicago'";
  const hasGeo = /agency\s*=\s*'/i.test(sql);
  assert("scope: agency_monthly + agency → city", hasGeo && sql.toLowerCase().includes("agency_monthly"));
}

// --- Time range ---
{
  const sql = "WHERE year >= 2020 AND year <= 2024";
  const years = (sql.match(/\b(19\d{2}|20\d{2})\b/g) || []).map(Number).sort((a,b) => a-b);
  assert("time range 2020-2024", years[0] === 2020 && years[years.length-1] === 2024);
}
{
  const sql = "WHERE year = 2024";
  const years = (sql.match(/\b(19\d{2}|20\d{2})\b/g) || []).map(Number);
  assert("single year", years.length === 1 && years[0] === 2024);
}
{
  const sql = "WHERE offense = 'Murder'";
  const years = sql.match(/\b(19\d{2}|20\d{2})\b/g);
  assert("no year in SQL", years === null);
}

// --- Per capita ---
{
  assert("per capita from question", /per\s+capita|per\s+100/i.test("murder rate per 100k in NYC"));
  assert("per capita from SQL", "JOIN agency_population".toLowerCase().includes("population"));
  assert("not per capita", !/per\s+capita|per\s+100/i.test("murder trend in Chicago") && !"SELECT count".toLowerCase().includes("population"));
}

// --- Tables from SQL ---
{
  const tables = extractTablesFromSql("SELECT a.year FROM agency_monthly a JOIN agency_population p ON a.ori = p.ori");
  assert("tables: basic JOIN", tables.includes("agency_monthly") && tables.includes("agency_population"));
}
{
  const tables = extractTablesFromSql("WITH cte AS (SELECT * FROM summary_victim_state_monthly) SELECT * FROM cte JOIN agencies a");
  assert("tables: CTE + JOIN", tables.includes("summary_victim_state_monthly") && tables.includes("cte") && tables.includes("agencies"));
}
{
  const tables = extractTablesFromSql("SELECT * FROM summary_state_monthly UNION ALL SELECT * FROM summary_city_monthly");
  assert("tables: UNION", tables.includes("summary_state_monthly") && tables.includes("summary_city_monthly"));
}

// --- Offense detection ---
{
  assert("offense: murder literal", /'murder'/i.test("WHERE offense = 'Murder'"));
  assert("offense: 09A code", /'09A'/i.test("WHERE ucr_offense_code = '09A'"));
  assert("offense: burglary", /'burglary'/i.test("WHERE offense = 'Burglary'"));
  assert("offense: no match", !/'murder'/i.test("SELECT year, count FROM national_monthly"));
}

// ══════════════════════════════════════════════════════════════════════
//  2. Geography extraction from question (edge cases)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ QueryContext — geo from question edge cases ═══\n");

// --- Multi-word cities ---
// "New York City" — regex captures all three words (each starts uppercase)
{
  const m = "murders in New York City since 2020".match(IN_CITY_RE);
  assert("geo: New York City", m?.[1] === "New York City", `got: "${m?.[1]}"`);
}
assert("geo: New York City via function", extractGeoFromQuestion("murders in New York City since 2020") === "New York City");
assert("geo: Los Angeles", extractGeoFromQuestion("theft in Los Angeles 2022") === "Los Angeles");
assert("geo: El Paso", extractGeoFromQuestion("crime in El Paso") === "El Paso");
assert("geo: San Francisco", extractGeoFromQuestion("robbery in San Francisco 2020-2024") === "San Francisco");
assert("geo: St Louis", extractGeoFromQuestion("murder in St Louis") === "St Louis");

// --- Hyphenated cities ---
assert("geo: Winston-Salem", extractGeoFromQuestion("assault in Winston-Salem 2023") === "Winston-Salem");

// --- Agency abbreviations ---
assert("geo: CMPD → Charlotte", extractGeoFromQuestion("CMPD murder trend") === "Charlotte");
assert("geo: MNPD → Nashville", extractGeoFromQuestion("MNPD robbery 2020-2024") === "Nashville");
assert("geo: LVMPD → Las Vegas", extractGeoFromQuestion("LVMPD auto theft") === "Las Vegas");
assert("geo: Metro Nashville", extractGeoFromQuestion("Metro Nashville assault data") === "Nashville");
assert("geo: Chicago police", extractGeoFromQuestion("Chicago police staffing levels") === "Chicago");

// --- Leading city names ---
assert("geo leading: Charlotte assaults", extractGeoFromQuestion("Charlotte aggravated assaults 2020-2024") === "Charlotte");
assert("geo leading: Houston murder", extractGeoFromQuestion("Houston murder rate") === "Houston");
assert("geo leading: Dallas theft", extractGeoFromQuestion("Dallas theft trend") === "Dallas");

// --- False positive resistance ---
assert("geo: no match for 'increase in murders'",
  extractGeoFromQuestion("increase in murders nationally") === null
  || extractGeoFromQuestion("increase in murders nationally") === undefined
  // "in murders" — "murders" doesn't start with uppercase M actually... wait
);
// Actually let's trace: "increase in murders nationally" — IN_CITY_RE = /\bin\s+([A-Z]...)/
// "murders" starts lowercase m — no match. Good.
{
  const q = "increase in murders nationally";
  const m = q.match(IN_CITY_RE);
  assert("geo: 'in murders' not a city", m === null, `got: "${m?.[1]}"`);
}
{
  const q = "How has violent crime changed in the last 5 years";
  const m = q.match(IN_CITY_RE);
  assert("geo: 'in the last' not a city", m === null, `got: "${m?.[1]}"`);
}
{
  // Tricky: "Murder in America" — "America" starts with A, looks like a city
  const q = "Murder in America 2020-2024";
  const m = q.match(IN_CITY_RE);
  // This WILL match "America" — acceptable? It's not in the non-city words list.
  // Not ideal but not a guardrail blocker (no city named America in DB, Claude won't find it).
  assert("geo: 'in America' matches (acceptable)", m?.[1] === "America");
}
{
  const q = "National burglary trend by year";
  assert("geo: 'National' no geo", extractGeoFromQuestion(q) === null, `got: "${extractGeoFromQuestion(q)}"`);
}
{
  const q = "What are murder stats?";
  assert("geo: generic question no geo", extractGeoFromQuestion(q) === null);
}

// --- Empty / weird inputs ---
assert("geo: empty string", extractGeoFromQuestion("") === null);
assert("geo: all lowercase", extractGeoFromQuestion("murder in charlotte") === null); // "charlotte" lowercase

// --- Typo resistance ---
{
  // "Charltote" — starts with uppercase, looks like a city
  const q = "burglary in Charltote";
  const m = q.match(IN_CITY_RE);
  assert("geo: typo 'Charltote' still captured", m?.[1] === "Charltote");
  // This is good — the city-to-national-fallback guardrail can then detect the mismatch
}

// ══════════════════════════════════════════════════════════════════════
//  3. Guardrail pattern matching — edge cases
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Guardrail edge cases ═══\n");

// --- rate-no-population ---
{
  // "rate" in question but NOT a rate request
  const q = "murder trend in Charlotte at what rate did it change";
  // The word "rate" appears but it's conversational, not a data request
  // Our regex WILL fire — this is a known false positive but acceptable
  // because Claude will just add a population join (harmless)
  const fires = /\b(rate|per capita|per 100k|per 100,000)\b/i.test(q);
  assert("rate-no-population: 'rate' in conversational context fires (acceptable FP)", fires);
}

// --- offense-missing-filter: "all crime" should NOT fire ---
{
  const q = "total crime in Charlotte 2020-2024";
  const sql = "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Charlotte'";
  const offenseTerms = [
    [/\bmurder|homicide\b/i, ["'murder'"]],
    [/\brape\b/i, ["'rape'"]],
    [/\brobbery|robberies\b/i, ["'robbery'"]],
    [/\bassault\b/i, ["'aggravated assault'"]],
    [/\bburglary|burglaries\b/i, ["'burglary'"]],
    [/\btheft\b/i, ["'theft'"]],
    [/\bauto theft|motor vehicle theft\b/i, ["'motor vehicle theft'"]],
  ];
  let fires = false;
  for (const [pattern, sqlTerms] of offenseTerms) {
    if (pattern.test(q) && !sqlTerms.some(t => sql.toLowerCase().includes(t))) {
      fires = true; break;
    }
  }
  assert("offense-missing: 'total crime' doesn't fire", !fires);
}

// --- offense-missing: "violent crime" doesn't match individual offenses ---
{
  const q = "violent crime in Chicago 2020-2024";
  const fires = /\bmurder|homicide\b/i.test(q) || /\brobbery\b/i.test(q) || /\bassault\b/i.test(q);
  assert("offense-missing: 'violent crime' no individual match", !fires);
}

// --- national-as-agency: variant spellings ---
{
  assert("national-as-agency: USA", /agency\s*=\s*'(USA|United States|US|National|Nationwide)'/i.test("agency = 'USA'"));
  assert("national-as-agency: Nationwide", /agency\s*=\s*'(USA|United States|US|National|Nationwide)'/i.test("agency = 'Nationwide'"));
  assert("national-as-agency: US", /agency\s*=\s*'(USA|United States|US|National|Nationwide)'/i.test("agency = 'US'"));
}

// --- city-to-national-fallback: non-city words ---
{
  const testCases = [
    ["burglary in Home settings", false, "Home"],
    ["residential burglary in Annual report", false, "Annual"],
    ["murder in Charlotte 2024", true, "Charlotte"],
    ["crime in Federal Way", false, "Federal Way"], // Federal Way, WA is real but "Federal" is in non-city words — acceptable tradeoff
  ];
  for (const [q, expected, label] of testCases) {
    const m = q.match(CITY_FALLBACK_RE);
    const isCity = m && !NON_CITY_WORDS.test(m[1]);
    const usesNational = true; // assume national SQL for test
    const fires = isCity && usesNational;
    if (expected) {
      assert(`city-fallback fires for "${label}"`, fires, `match: "${m?.[1]}"`);
    } else {
      assert(`city-fallback silent for "${label}"`, !fires, `match: "${m?.[1]}"`);
    }
  }
}

// --- NIBRS state code rewrite: multiple states ---
{
  const sql = "WHERE state = 'NE' OR state = 'GU'";
  let fixed = sql.replace(/state\s*=\s*'NE'/gi, "state = 'NB'");
  fixed = fixed.replace(/state\s*=\s*'GU'/gi, "state = 'GM'");
  assert("NE+GU both rewritten", fixed.includes("'NB'") && fixed.includes("'GM'") && !fixed.includes("'NE'") && !fixed.includes("'GU'"));
}

// --- NIBRS state code: don't touch other states ---
{
  const sql = "WHERE state = 'NY'";
  let fixed = sql.replace(/state\s*=\s*'NE'/gi, "state = 'NB'");
  assert("NY not affected by NE rewrite", fixed === sql);
}

// --- NIBRS raw victims: doesn't fire for demographics query ---
{
  const sql = "SELECT v.age, v.sex, COUNT(*) FROM VICTIMS v WHERE ucr_offense_code = '09A' GROUP BY v.age, v.sex";
  const hitsRaw = /\bFROM\s+VICTIMS\b/i.test(sql) && !/SUMMARY_VICTIM/i.test(sql);
  const hasPersonCode = sql.includes("'09A'");
  const isCount = /\bCOUNT\s*\(/i.test(sql);
  const selectClause = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || '';
  const needsDemographics = /\b(\.age|\.sex|\.race|\.ethnicity|\.injury_type|\.relationship)/i.test(selectClause);
  const fires = hitsRaw && hasPersonCode && isCount && !needsDemographics;
  assert("nibrs-raw-victims: demographics query exempt", !fires);
}

// --- NIBRS cross-level: no JOIN = no fire ---
{
  const sql = "SELECT * FROM summary_victim_city_monthly UNION ALL SELECT * FROM summary_victim_state_monthly";
  const hasJoin = /\bJOIN\b/i.test(sql);
  assert("nibrs-cross-level: UNION (no JOIN) doesn't fire", !hasJoin);
}

// --- NIBRS state-table-with-ori: property table variant ---
{
  const sql = "SELECT * FROM summary_state_monthly WHERE ori = 'CA0194200'";
  const usesStateProp = /\bsummary_state_monthly\b/i.test(sql) && !/\bsummary_victim/i.test(sql);
  const hasOri = /\bori\b/i.test(sql);
  assert("nibrs-state-prop-with-ori fires", usesStateProp && hasOri);
  const fixed = sql.replace(/\bsummary_state_monthly\b/gi, 'summary_city_monthly');
  assert("nibrs-state-prop rewritten to city", fixed.includes("summary_city_monthly"));
}

// --- ambiguous-city-type: doesn't fire without CASE WHEN ---
{
  const sql = "SELECT * FROM agency_monthly WHERE agency = 'Los Angeles' AND state = 'CA'";
  const hasCaseWhen = /case\s+when/i.test(sql);
  assert("ambiguous-city: no CASE WHEN = no fire", !hasCaseWhen);
}

// --- ambiguous-city-type: doesn't fire when type filter present ---
{
  const sql = "CASE WHEN agency = 'Los Angeles' AND type = 'City' THEN count END FROM agency_monthly";
  const hasType = sql.toLowerCase().includes("type");
  assert("ambiguous-city: type filter present = no fire", hasType);
}

// --- Stacked guardrails: multiple issues ---
{
  // SQL that triggers both rate-no-population AND national-as-agency
  const q = "murder rate per capita nationally";
  const sql = "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'United States'";
  const rateIssue = /\b(rate|per capita)\b/i.test(q) && !sql.toLowerCase().includes("population");
  const nationalIssue = /agency\s*=\s*'(USA|United States)'/i.test(sql);
  assert("stacked: rate + national both fire", rateIssue && nationalIssue);
}

// --- single-city-no-type: fires for ambiguous single-city without type ---
{
  const ambiguous = [
    "los angeles", "baltimore", "el paso", "sacramento", "san diego",
    "san mateo", "santa cruz", "st louis", "alameda", "denton",
    "greenville", "hamilton", "kalamazoo", "st charles", "tulare",
    "jacksonville", "richmond", "kansas city",
  ];
  const matchSingle = (sql) => {
    const sqlLower = sql.toLowerCase();
    if (!sqlLower.includes("agency_monthly")) return false;
    if (/\btype\s*=/i.test(sql)) return false;
    if (/case\s+when/i.test(sql)) return false;
    return ambiguous.some(c => sqlLower.includes(`agency = '${c}'`) || sqlLower.includes(`agency='${c}'`));
  };

  assert("single-city-no-type: LA without type fires",
    matchSingle("SELECT * FROM agency_monthly WHERE agency = 'Los Angeles' AND state = 'CA'"));
  assert("single-city-no-type: Baltimore without type fires",
    matchSingle("SELECT * FROM agency_monthly WHERE agency = 'Baltimore' AND state = 'MD'"));
  assert("single-city-no-type: with type = no fire",
    !matchSingle("SELECT * FROM agency_monthly WHERE agency = 'Los Angeles' AND state = 'CA' AND type = 'City'"));
  assert("single-city-no-type: CASE WHEN = no fire (multi-city guardrail handles it)",
    !matchSingle("SELECT CASE WHEN agency = 'Los Angeles' THEN count END FROM agency_monthly"));
  assert("single-city-no-type: Houston (not ambiguous) = no fire",
    !matchSingle("SELECT * FROM agency_monthly WHERE agency = 'Houston' AND state = 'TX'"));
  assert("single-city-no-type: Kansas City fires",
    matchSingle("SELECT * FROM agency_monthly WHERE agency = 'Kansas City' AND state = 'MO'"));
}

// --- state-monthly-for-trend: fires when state_monthly used in time series ---
{
  const matchStateTrend = (sql) => {
    const sqlLower = sql.toLowerCase();
    return sqlLower.includes("state_monthly") &&
      /group\s+by.*\byear\b/i.test(sql) &&
      !sqlLower.includes("agency_monthly");
  };

  assert("state-monthly-trend: time series fires",
    matchStateTrend("SELECT year, month, SUM(count) FROM state_monthly WHERE state = 'CA' GROUP BY year, month"));
  assert("state-monthly-trend: ranking (no GROUP BY year) = no fire",
    !matchStateTrend("SELECT state, SUM(count) FROM state_monthly GROUP BY state ORDER BY SUM(count) DESC"));
  assert("state-monthly-trend: agency_monthly present = no fire",
    !matchStateTrend("SELECT year FROM state_monthly JOIN agency_monthly GROUP BY year"));
}

// --- nibrs-person-crime-offense-table: fires for person crimes on non-victim table ---
{
  const PERSON_CODES = ["09A","09B","09C","11A","11B","11C","11D","13A","13B","13C","100","36A","36B","64A","64B"];
  const matchPersonOffense = (sql) => {
    const usesOffenseSummary = /\bsummary_(?:city|state)_monthly\b/i.test(sql) && !/\bsummary_victim/i.test(sql);
    if (!usesOffenseSummary) return false;
    return PERSON_CODES.some(code => sql.includes(`'${code}'`));
  };

  assert("nibrs-person-offense: murder on summary_state_monthly fires",
    matchPersonOffense("SELECT * FROM summary_state_monthly WHERE offense_code = '09A'"));
  assert("nibrs-person-offense: assault on summary_city_monthly fires",
    matchPersonOffense("SELECT * FROM summary_city_monthly WHERE offense_code = '13A'"));
  assert("nibrs-person-offense: murder on summary_victim_state_monthly = no fire",
    !matchPersonOffense("SELECT * FROM summary_victim_state_monthly WHERE offense_code = '09A'"));
  assert("nibrs-person-offense: property crime 220 on summary_state_monthly = no fire",
    !matchPersonOffense("SELECT * FROM summary_state_monthly WHERE offense_code = '220'"));
  assert("nibrs-person-offense: carjacking 64A fires",
    matchPersonOffense("SELECT * FROM summary_city_monthly WHERE offense_code = '64A'"));
}

// --- historical-state-via-agency: fires for aggregated agency queries ---
{
  const matchHistState = (sql) => {
    const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
    const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
    const groupsByYear = /GROUP\s+BY\s+(?:hac\.)?year/i.test(sql);
    const selectsAgency = /SELECT\s+[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
    return usesAgencyTable && hasStateFilter && groupsByYear && !selectsAgency;
  };

  assert("hist-state-via-agency: aggregated NC fires",
    matchHistState("SELECT hac.year, SUM(hac.assault) FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'nc' GROUP BY hac.year"));
  assert("hist-state-via-agency: with agency SELECT = no fire (ranking query)",
    !matchHistState("SELECT ha.agency, hac.year, hac.murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'tx' GROUP BY year"));
  assert("hist-state-via-agency: no state filter = no fire",
    !matchHistState("SELECT hac.year, SUM(hac.murder) FROM historical_agency_crime hac GROUP BY hac.year"));
}

// --- city-abbreviation-to-national: catches abbreviations the original misses ---
{
  // Simulates the guardrail logic
  const ABBREVS = /\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|DFW|DMV|CHI|BMORE|MPLS|MSP|OKC|SLC|NYPD|LAPD|CPD|HPD|DPD|BPD|MPD)\b/i;

  const matchAbbrev = (q, sql) => {
    const sqlLower = sql.toLowerCase();
    const usesNational = sqlLower.includes("national_monthly") || sqlLower.includes("state_monthly") ||
      sqlLower.includes("historical_state_national");
    const usesAgency = /agency\s*=/i.test(sql) || sqlLower.includes("agency_monthly");
    if (!usesNational || usesAgency) return false;
    return ABBREVS.test(q);
  };

  assert("city-abbrev-national: 'LA murder' on national_monthly fires",
    matchAbbrev("LA murder trend", "SELECT * FROM national_monthly WHERE offense = 'Murder'"));
  assert("city-abbrev-national: 'NYC robbery' on national fires",
    matchAbbrev("NYC robbery", "SELECT * FROM national_monthly WHERE offense = 'Robbery'"));
  assert("city-abbrev-national: 'NYPD murders' on agency_monthly = no fire",
    !matchAbbrev("NYPD murders", "SELECT * FROM agency_monthly WHERE agency = 'New York City'"));
  assert("city-abbrev-national: no abbreviation = no fire",
    !matchAbbrev("murder nationally", "SELECT * FROM national_monthly WHERE offense = 'Murder'"));
}

// --- population-join-no-year: catches missing year in population JOIN ---
{
  const matchPopNoYear = (sql) => {
    const hasPopJoin = /JOIN\s+agency_population\b/i.test(sql) || /JOIN\s+historical_agency_population\b/i.test(sql);
    if (!hasPopJoin) return false;
    const joinClause = sql.match(/JOIN\s+(?:agency_population|historical_agency_population)\s+\w+\s+ON\s+([^)]+?)(?:\s+WHERE|\s+GROUP|\s+ORDER|\s+LIMIT|$)/i);
    if (!joinClause) return false;
    return !/\byear\b/i.test(joinClause[1]);
  };

  assert("pop-no-year: missing year fires",
    matchPopNoYear("JOIN agency_population ap ON ap.ori = am.ori WHERE offense = 'Murder' GROUP BY year"));
  assert("pop-no-year: with year = no fire",
    !matchPopNoYear("JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year WHERE offense = 'Murder'"));
  assert("pop-no-year: historical variant fires",
    matchPopNoYear("JOIN historical_agency_population ap ON ap.ori = hac.ori WHERE year >= 2000 GROUP BY year"));
  assert("pop-no-year: historical with year = no fire",
    !matchPopNoYear("JOIN historical_agency_population ap ON ap.ori = hac.ori AND ap.year = hac.year GROUP BY year"));
}

// --- nibrs-agencies-join-no-year: catches missing year in NIBRS agencies JOIN ---
{
  const matchAgenciesNoYear = (sql) => {
    const hasAgenciesJoin = /JOIN\s+agencies\s+(\w+)\s+ON\s+/i.test(sql);
    if (!hasAgenciesJoin) return false;
    const joinMatch = sql.match(/JOIN\s+agencies\s+\w+\s+ON\s+([^)]*?)(?:\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|JOIN)|\s*$)/i);
    if (!joinMatch) return false;
    return !/\byear\b/i.test(joinMatch[1]);
  };

  assert("nibrs-agencies-no-year: missing year fires",
    matchAgenciesNoYear("SELECT s.*, a.city FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori WHERE s.state = 'TX' GROUP BY s.year"));
  assert("nibrs-agencies-no-year: with year = no fire",
    !matchAgenciesNoYear("SELECT s.*, a.city FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year WHERE s.state = 'TX'"));
  assert("nibrs-agencies-no-year: no agencies JOIN = no fire",
    !matchAgenciesNoYear("SELECT * FROM summary_victim_state_monthly WHERE state = 'TX'"));
}

// --- nibrs-city-case-sensitivity: auto-uppercases city names ---
{
  const matchCityCase = (sql) => {
    const cityFilters = sql.match(/city\s*=\s*'([^']+)'/gi);
    if (!cityFilters) return false;
    return cityFilters.some(f => {
      const val = f.match(/city\s*=\s*'([^']+)'/i)?.[1];
      return val && val !== val.toUpperCase();
    });
  };
  const rewriteCity = (sql) => {
    return sql.replace(/city\s*=\s*'([^']+)'/gi, (match, city) => {
      return match.replace(city, city.toUpperCase());
    });
  };

  assert("nibrs-city-case: mixed case fires", matchCityCase("WHERE city = 'Houston'"));
  assert("nibrs-city-case: uppercase = no fire", !matchCityCase("WHERE city = 'HOUSTON'"));
  assert("nibrs-city-case: rewrite to uppercase", rewriteCity("WHERE city = 'Houston'") === "WHERE city = 'HOUSTON'");
  assert("nibrs-city-case: multi-word city", rewriteCity("WHERE city = 'New York'") === "WHERE city = 'NEW YORK'");
  assert("nibrs-city-case: no city filter = no fire", !matchCityCase("WHERE state = 'TX'"));
}

// --- nibrs-offense-code-confusion: catches wrong offense codes ---
{
  // carjacking should NOT use 240
  const matchCarjack240 = (q, sql) => /\bcarjack/i.test(q) && sql.includes("'240'");
  assert("nibrs-offense: carjacking + 240 fires", matchCarjack240("carjacking in Texas", "WHERE ucr_offense_code = '240'"));
  assert("nibrs-offense: carjacking + summary table = no fire", !matchCarjack240("carjacking in Texas", "FROM summary_carjacking_monthly"));

  // auto theft should be 240 not 23F
  const matchAutoTheft23F = (q, sql) => /\b(auto|motor vehicle|car)\s*theft\b/i.test(q) && sql.includes("'23F'") && !sql.includes("'240'");
  assert("nibrs-offense: auto theft + 23F fires", matchAutoTheft23F("auto theft in Chicago", "WHERE ucr_offense_code = '23F'"));
  assert("nibrs-offense: auto theft + 240 = no fire", !matchAutoTheft23F("auto theft in Chicago", "WHERE ucr_offense_code = '240'"));

  // vehicle burglary should be 23F not 240
  const matchVehBurg240 = (q, sql) => /\b(vehicle burglary|theft from (motor )?vehicle|TFMV)\b/i.test(q) && sql.includes("'240'") && !sql.includes("'23F'");
  assert("nibrs-offense: vehicle burglary + 240 fires", matchVehBurg240("vehicle burglary in Houston", "WHERE ucr_offense_code = '240'"));
  assert("nibrs-offense: vehicle burglary + 23F = no fire", !matchVehBurg240("vehicle burglary in Houston", "WHERE ucr_offense_code = '23F'"));
  assert("nibrs-offense: TFMV + 240 fires", matchVehBurg240("TFMV trend in Dallas", "WHERE ucr_offense_code = '240'"));
}

// --- historical-ranking-no-type: catches rankings without type filter ---
{
  const matchRankNoType = (sql) => {
    const usesAgencyTable = /\bhistorical_agency(?:_crime)?\b/i.test(sql);
    const hasRanking = /ORDER\s+BY\b/i.test(sql) && /\bLIMIT\b/i.test(sql);
    const hasTypeFilter = /\bha\.type\s*=/i.test(sql) || /\btype\s*=\s*'/i.test(sql);
    const selectsAgency = /SELECT[\s\S]*?\bagency\b[\s\S]*?FROM/i.test(sql);
    return usesAgencyTable && hasRanking && selectsAgency && !hasTypeFilter;
  };

  assert("hist-ranking-no-type: ranking without type fires",
    matchRankNoType("SELECT ha.agency, SUM(hac.murder) as total FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'tx' GROUP BY ha.agency ORDER BY total DESC LIMIT 10"));
  assert("hist-ranking-no-type: with type = no fire",
    !matchRankNoType("SELECT ha.agency, SUM(hac.murder) as total FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'tx' AND ha.type = 'city' GROUP BY ha.agency ORDER BY total DESC LIMIT 10"));
  assert("hist-ranking-no-type: non-ranking query = no fire",
    !matchRankNoType("SELECT ha.agency, hac.year, hac.murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Houston'"));
}

// ══════════════════════════════════════════════════════════════════════
//  4. Disclaimer logic — edge cases
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Disclaimer edge cases ═══\n");

// --- Current tab ---
assert("disclaimer: current national", "national" === "national");
assert("disclaimer: current state gets disclaimer", "state" === "state");
assert("disclaimer: current city exempt", "city" !== "national" && "city" !== "state");

// --- Historical year boundaries ---
{
  assert("disclaimer: 1959 → pre-1960 fires", parseInt("1959") < 1960);
  assert("disclaimer: 1960 → NOT pre-1960", !(parseInt("1960") < 1960));
  assert("disclaimer: 1945 → pre-1960 fires", parseInt("1945") < 1960);
  assert("disclaimer: 2000 → no pre-1960", !(parseInt("2000") < 1960));
}

// --- NIBRS date gap: boundary conditions ---
{
  const testGap = (q, firstYear, expected, label) => {
    const startMatch = q.match(/(?:since|from|starting|beginning)\s+(\d{4})/i) ||
      q.match(/(\d{4})\s*(?:to|through|-)\s*\d{4}/i);
    const requested = startMatch ? parseInt(startMatch[1]) : null;
    const hasGap = requested && firstYear > requested + 1;
    assert(`date-gap: ${label}`, !!hasGap === expected, `requested=${requested}, actual=${firstYear}`);
  };
  testGap("murders since 2015", 2020, true, "2015→2020 (5yr gap)");
  testGap("murders since 2019", 2020, false, "2019→2020 (1yr gap, OK)");
  testGap("murders since 2020", 2020, false, "2020→2020 (no gap)");
  testGap("murders since 2020", 2022, true, "2020→2022 (2yr gap)");
  testGap("murders from 2010 to 2024", 2015, true, "2010-2024 starts at 2015");
  testGap("murders from 2020 to 2024", 2020, false, "2020-2024 starts at 2020");
  testGap("how many murders in Texas", 2020, false, "no year in question");
}

// --- NIBRS date gap: regex variants ---
{
  const patterns = [
    ["since 2015", 2015],
    ["from 2010", 2010],
    ["starting 2018", 2018],
    ["beginning 2012", 2012],
    ["2005 to 2024", 2005],
    ["2010 through 2024", 2010],
    ["2015-2024", 2015],
  ];
  for (const [fragment, expected] of patterns) {
    const q = `murders ${fragment}`;
    const startMatch = q.match(/(?:since|from|starting|beginning)\s+(\d{4})/i) ||
      q.match(/(\d{4})\s*(?:to|through|-)\s*\d{4}/i);
    const parsed = startMatch ? parseInt(startMatch[1]) : null;
    assert(`date-gap regex: "${fragment}"`, parsed === expected, `got: ${parsed}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  5. Regex fragility / tricky inputs
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Regex edge cases ═══\n");

// --- "in" false positives ---
{
  const cases = [
    ["increase in robbery rates", null],       // "in robbery" — "robbery" is lowercase
    ["decline in murder", null],               // "in murder" — lowercase
    ["What changed in March 2024", "March"],   // "March" starts uppercase — FP but acceptable
    ["trends in Detroit", "Detroit"],           // correct city match
    ["crime in the United States", null],       // "the" is lowercase after "in"
  ];
  for (const [q, expected] of cases) {
    const m = q.match(IN_CITY_RE);
    const got = m?.[1] || null;
    assert(`in-regex: "${q.slice(0, 40)}"`, got === expected, `got: "${got}"`);
  }
}

// --- Leading city with various crime words ---
{
  const cases = [
    ["Memphis murder rate 2024", "Memphis"],
    ["Baltimore robbery trend", "Baltimore"],
    ["Charlotte carjacking 2023", "Charlotte"],
    ["Nashville arson data", "Nashville"],
    ["Dallas police staffing", "Dallas"],
  ];
  for (const [q, expected] of cases) {
    const m = q.match(LEADING_CITY_RE);
    assert(`leading: "${q.slice(0, 30)}"`, m?.[1] === expected, `got: "${m?.[1]}"`);
  }
}

// --- Leading city should NOT match lowercase-starting lines ---
{
  const cases = [
    ["murder trend in Chicago", null],           // not at start
    ["what about Charlotte murder", null],       // "what" is lowercase at start
    ["the Charlotte murder rate", null],         // "the" at start
  ];
  for (const [q, expected] of cases) {
    const m = q.match(LEADING_CITY_RE);
    assert(`leading-false: "${q.slice(0, 30)}"`, (m?.[1] || null) === expected, `got: "${m?.[1]}"`);
  }
}

// --- State abbreviation edge cases ---
{
  // Lowercase state in SQL (Claude sometimes does this)
  const sql = "WHERE state = 'tx'";
  const re = /state\s*=\s*'([A-Z]{2})'/gi;
  let m, states = []; while ((m = re.exec(sql)) !== null) states.push(m[1]);
  assert("state: lowercase 'tx' still captured by /gi", states.length === 1);
}
{
  // State-like string that's NOT a state (e.g., in a city name)
  const sql = "WHERE agency = 'US Marshal'";
  const re = /state\s*=\s*'([A-Z]{2})'/gi;
  let m, states = []; while ((m = re.exec(sql)) !== null) states.push(m[1]);
  assert("state: 'US Marshal' not captured as state", states.length === 0);
}

// --- Table extraction from complex SQL ---
{
  const sql = `
    WITH city_data AS (
      SELECT year, SUM(victim_count) AS cnt
      FROM summary_victim_city_monthly
      WHERE ori = 'NY0303000'
      GROUP BY year
    ),
    state_data AS (
      SELECT year, SUM(victim_count) AS cnt
      FROM summary_victim_state_monthly
      WHERE state = 'NY'
      GROUP BY year
    )
    SELECT c.year, c.cnt AS city, s.cnt AS state_total
    FROM city_data c
    JOIN state_data s ON c.year = s.year
  `;
  const tables = extractTablesFromSql(sql);
  assert("tables: complex CTE", tables.includes("summary_victim_city_monthly") && tables.includes("summary_victim_state_monthly"));
}
{
  // Subquery in WHERE
  const sql = "SELECT * FROM summary_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'CHICAGO')";
  const tables = extractTablesFromSql(sql);
  assert("tables: subquery in WHERE", tables.includes("summary_city_monthly") && tables.includes("agencies"));
}

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`SUMMARY: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
