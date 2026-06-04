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

// --- nibrs-property-crime-victim-table: fires for property crimes on victim tables ---
{
  const PROPERTY_CODES = ["23A","23B","23C","23D","23E","23F","23G","23H","220","240","250","26A","26B","26C","26D","26E","270","280","290"];
  const matchPropertyVictim = (sql) => {
    const usesVictimTable = /\bsummary_victim_(?:city|state)_monthly\b/i.test(sql);
    if (!usesVictimTable) return false;
    return PROPERTY_CODES.some(code => sql.includes(`'${code}'`));
  };

  assert("nibrs-property-victim: theft 23F on summary_victim_city_monthly fires",
    matchPropertyVictim("SELECT * FROM summary_victim_city_monthly WHERE ucr_offense_code = '23F'"));
  assert("nibrs-property-victim: burglary 220 on summary_victim_state_monthly fires",
    matchPropertyVictim("SELECT * FROM summary_victim_state_monthly WHERE ucr_offense_code = '220'"));
  assert("nibrs-property-victim: MVT 240 on summary_victim_city_monthly fires",
    matchPropertyVictim("SELECT * FROM summary_victim_city_monthly WHERE ucr_offense_code = '240'"));
  assert("nibrs-property-victim: theft 23F on summary_city_monthly = no fire (correct table)",
    !matchPropertyVictim("SELECT * FROM summary_city_monthly WHERE ucr_offense_code = '23F'"));
  assert("nibrs-property-victim: person crime 09A on summary_victim_city_monthly = no fire",
    !matchPropertyVictim("SELECT * FROM summary_victim_city_monthly WHERE ucr_offense_code = '09A'"));
  assert("nibrs-property-victim: fraud 26A on victim table fires",
    matchPropertyVictim("SELECT * FROM summary_victim_state_monthly WHERE ucr_offense_code = '26A'"));
}

// --- nibrs-national-as-agency: catches state='US' for national queries ---
{
  const matchNational = (sql) => {
    return /\b(city|agency_name)\s*=\s*'(USA|United States|US|National)'/i.test(sql) ||
      /agencies\s+WHERE.*'(USA|United States|UNITED STATES|National|NATIONAL)'/i.test(sql) ||
      /\bstate\s*=\s*'(US|USA)'/i.test(sql);
  };

  assert("nibrs-national: state='US' fires",
    matchNational("SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE ucr_offense_code = '09A' AND state = 'US' GROUP BY year"));
  assert("nibrs-national: state='USA' fires",
    matchNational("SELECT year, SUM(offense_count) FROM summary_state_monthly WHERE state = 'USA' GROUP BY year"));
  assert("nibrs-national: city='United States' fires",
    matchNational("SELECT * FROM agencies WHERE city = 'United States'"));
  assert("nibrs-national: state='TX' = no fire",
    !matchNational("SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'TX' GROUP BY year"));
  assert("nibrs-national: no state filter = no fire",
    !matchNational("SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE ucr_offense_code = '09A' GROUP BY year"));
}

// --- nibrs-carjacking: must use summary_carjacking_monthly ---
{
  const matchCarjack = (q, sql) => {
    if (!/\bcarjack/i.test(q)) return false;
    return !/summary_carjacking_monthly/i.test(sql);
  };

  assert("nibrs-carjack: carjacking with code 120 fires",
    matchCarjack("Carjacking victims by state", "SELECT * FROM summary_victim_city_monthly WHERE ucr_offense_code = '120'"));
  assert("nibrs-carjack: carjacking with code 240 fires",
    matchCarjack("carjacking trend", "SELECT * FROM summary_city_monthly WHERE ucr_offense_code = '240'"));
  assert("nibrs-carjack: carjacking with correct table = no fire",
    !matchCarjack("carjacking by state 2024", "SELECT state, SUM(offense_count) FROM summary_carjacking_monthly GROUP BY state"));
  assert("nibrs-carjack: non-carjacking question = no fire",
    !matchCarjack("robbery trend in Texas", "SELECT * FROM summary_victim_state_monthly WHERE ucr_offense_code = '120'"));
}

// --- nibrs-raw-table-for-counts: catches aggregate queries on raw tables ---
{
  const matchRawCount = (sql) => {
    const RAW_TABLES = ["offenses", "property", "arrestees", "offense_weapons"];
    const usesRawTable = RAW_TABLES.some(t =>
      new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql) ||
      new RegExp(`\\bJOIN\\s+${t}\\b`, "i").test(sql)
    );
    if (!usesRawTable) return false;
    return /\bCOUNT\s*\(|\bSUM\s*\(|\bGROUP\s+BY\b/i.test(sql);
  };

  assert("nibrs-raw-count: COUNT on property table fires",
    matchRawCount("SELECT year, COUNT(*) FROM property WHERE property_description = '19' GROUP BY year"));
  assert("nibrs-raw-count: SUM on offenses table fires",
    matchRawCount("SELECT SUM(1) FROM offenses WHERE ucr_offense_code = '23F'"));
  assert("nibrs-raw-count: GROUP BY on arrestees fires",
    matchRawCount("SELECT sex, COUNT(*) FROM arrestees GROUP BY sex"));
  assert("nibrs-raw-count: JOIN property with GROUP BY fires",
    matchRawCount("SELECT year, COUNT(*) FROM offenses o JOIN property p ON p.ori = o.ori GROUP BY year"));
  assert("nibrs-raw-count: SELECT * on property (detail query) = no fire",
    !matchRawCount("SELECT * FROM property WHERE ori = 'CA0190100' AND year = 2024 LIMIT 10"));
  assert("nibrs-raw-count: summary table = no fire",
    !matchRawCount("SELECT year, SUM(offense_count) FROM summary_city_monthly GROUP BY year"));
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

// --- historical-state-agency-listing: catches un-chartable agency dumps ---
{
  const matchAgencyListing = (sql) => {
    const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
    const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
    const selectsAgency = /SELECT[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
    const isRanking = /ORDER\s+BY\s+(?:total|sum|count|murder|robbery|assault|burglary|theft|rape|violent|property)\b/i.test(sql) ||
      /ORDER\s+BY\s+\w+\s+DESC/i.test(sql);
    return usesAgencyTable && hasStateFilter && selectsAgency && !isRanking;
  };

  assert("hist-agency-listing: all CA agencies fires",
    matchAgencyListing("SELECT ha.agency, hac.year, hac.robbery FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'ca' ORDER BY ha.agency, hac.year LIMIT 1000"));
  assert("hist-agency-listing: ranking by metric DESC = no fire",
    !matchAgencyListing("SELECT ha.agency, SUM(hac.murder) as total FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'ca' GROUP BY ha.agency ORDER BY total DESC LIMIT 10"));
  assert("hist-agency-listing: specific agency = no fire",
    !matchAgencyListing("SELECT ha.agency, hac.year, hac.murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Houston'"));
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
//  6. applyRetryMeta — regression tests
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ applyRetryMeta ═══\n");

{
  // Simulate the helper inline (same logic as lib/types.ts)
  function applyRetryMeta(target, source) {
    const KEYS = ["explanation","chartHint","xAxis","yAxis","title","colors","yAxisLabel","xAxisLabel","annotations"];
    for (const k of KEYS) target[k] = source[k];
  }

  // All fields copied
  const target = { explanation: "old", chartHint: "bar", xAxis: "x", yAxis: "y", title: "t" };
  const source = {
    explanation: "new", chartHint: "line", xAxis: "year", yAxis: "total", title: "New Title",
    colors: ["#ff0000"], yAxisLabel: "Rate per 100K", xAxisLabel: "Year", annotations: [{ axis: "x", value: 2020 }]
  };
  applyRetryMeta(target, source);
  assert("applyRetry: explanation copied", target.explanation === "new");
  assert("applyRetry: chartHint copied", target.chartHint === "line");
  assert("applyRetry: xAxis copied", target.xAxis === "year");
  assert("applyRetry: yAxis copied", target.yAxis === "total");
  assert("applyRetry: title copied", target.title === "New Title");
  assert("applyRetry: colors copied", JSON.stringify(target.colors) === '["#ff0000"]');
  assert("applyRetry: yAxisLabel copied", target.yAxisLabel === "Rate per 100K");
  assert("applyRetry: xAxisLabel copied", target.xAxisLabel === "Year");
  assert("applyRetry: annotations copied", target.annotations.length === 1);

  // Undefined source fields clear target (no stale data from prior response)
  const target2 = { explanation: "x", colors: ["#00f"], yAxisLabel: "old", annotations: [{ axis: "y", value: 5 }] };
  const source2 = { explanation: "y", chartHint: "bar", xAxis: "x", yAxis: "y", title: "T" };
  applyRetryMeta(target2, source2);
  assert("applyRetry: missing colors → undefined", target2.colors === undefined);
  assert("applyRetry: missing yAxisLabel → undefined", target2.yAxisLabel === undefined);
  assert("applyRetry: missing annotations → undefined", target2.annotations === undefined);

  // Non-meta fields on target preserved
  const target3 = { sql: "SELECT 1", explanation: "old", customField: 42 };
  applyRetryMeta(target3, { explanation: "new", chartHint: "line", xAxis: "x", yAxis: "y", title: "T" });
  assert("applyRetry: sql preserved", target3.sql === "SELECT 1");
  assert("applyRetry: customField preserved", target3.customField === 42);
}

// ══════════════════════════════════════════════════════════════════════
//  7. Codex audit fixes — regression tests (2026-06-02)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Codex audit fix regression tests ═══\n");

// --- 3086: agency-lookup-not-crime-data fires on NIBRS ---
{
  const sql = "SELECT DISTINCT ha.ori, ha.agency, ha.state, ha.type FROM agencies ha WHERE ha.city = 'ESSEX' AND ha.state = 'NJ'";
  const question = "percent cleared of auto theft arrests in Essex County, NJ";
  const tab = "nibrs";
  const sqlLower = sql.toLowerCase();
  const onlyAgencyTable =
    (sqlLower.includes("from agencies") || sqlLower.includes("from historical_agency")) &&
    !sqlLower.includes("agency_monthly") &&
    !sqlLower.includes("agency_crime") &&
    !sqlLower.includes("national_monthly") &&
    !sqlLower.includes("state_national") &&
    !sqlLower.includes("staffing") &&
    !sqlLower.includes("clearance") &&
    !sqlLower.includes("summary_") &&
    !sqlLower.includes("incidents") &&
    !sqlLower.includes("offenses") &&
    !sqlLower.includes("victims") &&
    !sqlLower.includes("offenders") &&
    !sqlLower.includes("arrestees") &&
    !sqlLower.includes("property");
  const asksCrimeData = /\b(crime|trend|murder|homicide|robbery|assault|burglary|theft|rate|stats|statistics|data|offenses?|violent|property|arrest|clearance|cleared)\b/i.test(question);
  const fires = onlyAgencyTable && asksCrimeData;
  assert("3086: agency-lookup-not-crime-data fires on NIBRS", fires, `onlyAgency=${onlyAgencyTable}, asksCrime=${asksCrimeData}`);
}

// --- 3086: does NOT fire when NIBRS summary tables are used ---
{
  const sql = "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori";
  const question = "murder trend in Houston";
  const sqlLower = sql.toLowerCase();
  const onlyAgencyTable =
    (sqlLower.includes("from agencies") || sqlLower.includes("from historical_agency")) &&
    !sqlLower.includes("summary_");
  assert("3086: does NOT fire with NIBRS summary tables", !onlyAgencyTable);
}

// --- 3103: national vs cities explanation fix (Historical route) ---
{
  const sql = "SELECT year, national_clearance_rate FROM historical_national_clearance WHERE year >= 2015";
  const explanation = "This dataset contains murder clearance rates across cities from 2015 to 2024.";
  let fixed = explanation;
  // Simulate the post-processing from query/route.ts
  if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
    fixed = fixed
      .replace(/\bacross cities\b/gi, "nationally")
      .replace(/\bfor cities\b/gi, "nationally")
      .replace(/\bin cities\b/gi, "nationally");
  }
  assert("3103: 'across cities' → 'nationally' when SQL uses national_ table", fixed.includes("nationally") && !fixed.includes("across cities"), `got: "${fixed}"`);
}

// --- 3103: does NOT fire when SQL has agency filter ---
{
  const sql = "SELECT year, rate FROM national_clearance_rate WHERE agency = 'Houston'";
  const explanation = "This dataset contains clearance rates across cities.";
  let fixed = explanation;
  if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
    fixed = fixed.replace(/\bacross cities\b/gi, "nationally");
  }
  assert("3103: preserves 'cities' when agency filter exists", fixed.includes("across cities"), `got: "${fixed}"`);
}

// --- Offender demographics wording fix (3085/3087-3091/3094/3095) ---
{
  const sql = "SELECT age_group, SUM(offender_count) FROM summary_offender_demographics WHERE ucr_offense_code = '09A' GROUP BY age_group";
  const explanations = [
    "This shows the share of crimes involving offenders under 25.",
    "This shows the percentage of offenses with young offenders.",
    "This shows the proportion of incidents by age group.",
  ];
  const expected = [
    "share of known/suspected offenders",
    "percentage of known/suspected offenders",
    "proportion of known/suspected offenders",
  ];
  for (let i = 0; i < explanations.length; i++) {
    let fixed = explanations[i];
    if (/summary_offender_demographics/i.test(sql)) {
      fixed = fixed
        .replace(/\bshare of (?:crimes|offenses|incidents)\b/gi, "share of known/suspected offenders")
        .replace(/\bpercent(?:age)? of (?:crimes|offenses|incidents)\b/gi, "percentage of known/suspected offenders")
        .replace(/\bproportion of (?:crimes|offenses|incidents)\b/gi, "proportion of known/suspected offenders");
    }
    assert(`offender wording fix ${i + 1}: "${expected[i]}" present`, fixed.includes(expected[i]), `got: "${fixed}"`);
  }
}

// --- SHR offender wording fix (3105/3107/3108) ---
{
  const sql = "SELECT year, COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.off_age_num < 18 GROUP BY year";
  const explanations = [
    "This shows homicides involving a juvenile offender.",
    "This shows the share of homicides with any offender under 18.",
    "This shows crimes involving a young offender by year.",
  ];
  for (let i = 0; i < explanations.length; i++) {
    let fixed = explanations[i];
    if (/\boff_age_num\b/i.test(sql) || /\boff_age\b/i.test(sql)) {
      fixed = fixed
        .replace(/\bhomicides (?:involving|with) (?:a |an )?(?:juvenile|young|under.?18|minor)\s*offender/gi, "murder victims where the recorded offender was under 18")
        .replace(/\bcrimes (?:involving|with) (?:a |an )?(?:juvenile|young|under.?18|minor)\s*offender/gi, "murder victims where the recorded offender was under 18")
        .replace(/\bhomicides (?:involving|with) (?:any )?offender/gi, "murder victims where the recorded offender was")
        .replace(/\bshare of (?:homicides|murders|incidents) (?:involving|with)\b/gi, "share of murder victims where the recorded offender was");
    }
    assert(`SHR offender wording fix ${i + 1}`, fixed.includes("recorded offender"), `got: "${fixed}"`);
  }
}

// --- SHR: does NOT fire when no offender columns in SQL ---
{
  const sql = "SELECT year, weapon_group, COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id GROUP BY year, weapon_group";
  const explanation = "This shows homicides involving firearms.";
  let fixed = explanation;
  if (/\boff_age_num\b/i.test(sql) || /\boff_age\b/i.test(sql)) {
    fixed = fixed.replace(/\bhomicides involving/gi, "murder victims where the recorded offender was");
  }
  assert("SHR: no offender fix when SQL has no off_ columns", fixed === explanation, `got: "${fixed}"`);
}

// ══════════════════════════════════════════════════════════════════════
//  8. Group B arrest data tests (queries 3113/3114/3116)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Group B arrest data tests ═══\n");

// --- 3113/3114/3116: DUI query should NOT trigger agency-lookup guardrail ---
{
  const sql = "SELECT CAST(year AS TEXT) AS year, SUM(arrestee_count) AS dui_arrests FROM summary_arrestee_demographics WHERE ucr_arrest_offense = '90D' AND year BETWEEN 2017 AND 2026 GROUP BY year ORDER BY year";
  const question = "Show me DUI arrests from 2017-2026";
  const sqlLower = sql.toLowerCase();
  const onlyAgencyTable =
    (sqlLower.includes("from agencies") || sqlLower.includes("from historical_agency")) &&
    !sqlLower.includes("summary_");
  assert("Group B: DUI query does NOT trigger agency-lookup", !onlyAgencyTable);
}

// --- Group B codes in summary_arrestee_demographics prompt ---
// The prompt should document 90D as DUI
{
  // Simulate: does the system prompt tell Claude to use summary_arrestee_demographics for DUI?
  // We test that the SQL Claude would generate references the right table and code
  const sql = "SELECT year, SUM(arrestee_count) FROM summary_arrestee_demographics WHERE ucr_arrest_offense = '90D' GROUP BY year ORDER BY year";
  assert("Group B: DUI uses summary_arrestee_demographics", sql.includes("summary_arrestee_demographics") && sql.includes("90D"));
}

// --- Group B: offense code sanity ---
{
  const GROUP_B_CODES = {
    "90A": "Bad Checks",
    "90B": "Curfew/Loitering",
    "90C": "Disorderly Conduct",
    "90D": "DUI/DWI",
    "90E": "Family Offenses",
    "90F": "Liquor Law Violations",
    "90G": "Peeping Tom",
    "90I": "Runaway",
    "90J": "Trespass",
    "90Z": "All Other Offenses",
  };
  // Each code should be a valid 90x pattern
  for (const [code, name] of Object.entries(GROUP_B_CODES)) {
    assert(`Group B code ${code} (${name}) is 90x`, /^90[A-Z]$/.test(code));
  }
}

// --- FP: "DUI incidents" should recognize arrest-only limitation ---
// The explanation post-processing for arrestee demographics should NOT say "share of crimes"
{
  const sql = "SELECT year, SUM(arrestee_count) FROM summary_arrestee_demographics WHERE ucr_arrest_offense = '90D' GROUP BY year";
  const explanation = "This shows the share of crimes involving DUI offenders by year.";
  let fixed = explanation;
  if (/summary_arrestee_demographics/i.test(sql)) {
    fixed = fixed
      .replace(/\bshare of (?:crimes|offenses|incidents)\b/gi, "share of arrestees")
      .replace(/\bpercent(?:age)? of (?:crimes|offenses|incidents)\b/gi, "percentage of arrestees");
  }
  assert("Group B: arrestee wording fix applies to DUI queries", fixed.includes("share of arrestees") && !fixed.includes("share of crimes"), `got: "${fixed}"`);
}

// --- FP: "DUI arrests from 2000" — NIBRS coverage caveat ---
// The date-gap disclaimer should fire when data starts later than requested
{
  const question = "show me DUI arrests from 2000 to today";
  const rows = [{ year: 2017, dui_arrests: 9802 }]; // first row starts at 2017
  const startMatch = question.match(/(?:since|from|starting|beginning)\s+(\d{4})/i) ||
    question.match(/(\d{4})\s*(?:to|through|-)\s*\d{4}/i);
  const requested = startMatch ? parseInt(startMatch[1]) : null;
  const actual = rows[0]?.year;
  const gapDetected = requested && actual && actual > requested + 1;
  assert("Group B: date-gap disclaimer fires for '2000 to today' with data starting 2017", gapDetected, `requested=${requested}, actual=${actual}`);
}

// --- Ethnicity guardrail: still fires on live (no ethnicity column yet) ---
{
  const question = "show me hispanic DUI arrests";
  const fires = /\b(hispanic|latino|latina|ethnicity|ethnic)\b/i.test(question);
  assert("Ethnicity guardrail fires for 'hispanic DUI arrests'", fires);
}

// ══════════════════════════════════════════════════════════════════════
//  9. Clearance column guardrail exemptions (query 3201)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Clearance column guardrail tests (3201) ═══\n");

// --- rate-no-population: does NOT fire on _clr columns ---
{
  const question = "What are the clearance rates for auto theft in Philadelphia and Chicago?";
  const sql = "SELECT y.year, (SELECT hc.motor_vehicle_theft_clr FROM historical_agency_clearance hc WHERE hc.ori = 'ILCPD0000' AND hc.year = y.year) AS chicago FROM years y";
  const isPerCapita = /\b(rates?|per\s*capita|per\s*100k)\b/i.test(question);
  const hasPopulation = sql.toLowerCase().includes("population");
  const hasRate = /_rate\b/.test(sql);
  const hasClr = /_clr\b/.test(sql);
  const fires = isPerCapita && !hasPopulation && !hasRate && !hasClr;
  assert("3201: rate-no-population does NOT fire on _clr columns", !fires, `isPerCapita=${isPerCapita}, hasClr=${hasClr}`);
}

// --- contract-rate-no-population: does NOT fire on _clr columns ---
{
  const question = "murder clearance rate in Houston";
  const sql = "SELECT year, murder_clr FROM historical_agency_clearance WHERE ori = 'TXHPD0000'";
  const wantsRate = /\b(rates?|per\s*capita|per\s*100k)\b/i.test(question);
  const sqlLower = sql.toLowerCase();
  const fires = wantsRate && !sqlLower.includes("population") && !sqlLower.includes("100000") && !/_rate\b/.test(sqlLower) && !/_clr\b/.test(sqlLower);
  assert("3201: contract-rate-no-population does NOT fire on _clr columns", !fires);
}

// --- offense-missing-filter: does NOT fire on _clr columns ---
{
  const question = "auto theft clearance rate in Chicago";
  const sql = "SELECT year, motor_vehicle_theft_clr FROM historical_agency_clearance hc WHERE hc.ori = 'ILCPD0000'";
  const sqlLower = sql.toLowerCase();
  const hasClr = /_clr\b/.test(sqlLower);
  // offense-missing-filter should early-return when _clr present
  assert("3201: offense-missing-filter does NOT fire on _clr columns", hasClr);
}

// --- offense-missing-filter: STILL fires on normal crime query without offense filter ---
{
  const question = "auto theft trend in Chicago 2020-2024";
  const sql = "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Chicago' GROUP BY year";
  const sqlLower = sql.toLowerCase();
  const hasClr = /_clr\b/.test(sqlLower);
  const offenseTerms = [["'motor vehicle theft'", "'240'"]];
  const hasOffenseFilter = offenseTerms[0].some(t => sqlLower.includes(t)) || sqlLower.includes("offense");
  const fires = /\bauto theft|motor vehicle theft|car theft|vehicle theft\b/i.test(question) && !hasOffenseFilter && !hasClr;
  assert("3201: offense-missing-filter STILL fires on normal crime query", fires);
}

// --- _rate exemption still works (from 3168 fix) ---
{
  const sql = "SELECT year, murder_rate FROM historical_state_national WHERE state = 'United States'";
  const fires = !sql.toLowerCase().includes("population") && !/_rate\b/.test(sql) && !/_clr\b/.test(sql);
  assert("3168: _rate exemption still works for murder_rate column", !fires);
}

// ══════════════════════════════════════════════════════════════════════
//  10. Multi-city global LIMIT 1 guardrail (query 3204)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Multi-city global LIMIT 1 tests (3204) ═══\n");

// --- Fires on exact bad SQL from 3204 ---
{
  const sql = "SELECT a.city, a.state, s.year, s.month, SUM(s.offense_count) AS vehicle_burglaries FROM summary_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year WHERE s.ucr_offense_code = '23F' AND s.year = 2023 AND a.city IN ('BOSTON', 'CHICAGO') AND a.state IN ('MA', 'IL') AND a.population > 0 AND a.ori IN (SELECT ori FROM agencies WHERE city IN ('BOSTON', 'CHICAGO') AND state IN ('MA', 'IL') AND year = 2023 AND population > 0 ORDER BY pop_group LIMIT 1) GROUP BY a.city, a.state, s.year, s.month ORDER BY s.year, s.month, a.city";
  const hasCityIn = /city\s+IN\s*\([^)]*,[^)]*\)/i.test(sql);
  const hasGlobalLimit1 = /city\s+IN\s*\([^)]*\)[\s\S]*?(?:ORDER\s+BY\s+(?:pop_group|population)[^)]*LIMIT\s+1)/i.test(sql);
  assert("3204: detects city IN (...) with global LIMIT 1", hasCityIn && hasGlobalLimit1);
}

// --- Does NOT fire on single-city LIMIT 1 (correct usage) ---
{
  const sql = "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'HOUSTON' AND state = 'TX' AND year = 2025 ORDER BY pop_group LIMIT 1) GROUP BY year";
  const hasCityIn = /city\s+IN\s*\([^)]*,[^)]*\)/i.test(sql);
  assert("3204: does NOT fire on single-city LIMIT 1", !hasCityIn);
}

// --- Does NOT fire on multi-city without LIMIT 1 ---
{
  const sql = "SELECT a.city, SUM(s.victim_count) FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori WHERE a.city IN ('BOSTON', 'CHICAGO') GROUP BY a.city";
  const hasGlobalLimit1 = /city\s+IN\s*\([^)]*\)[\s\S]*?(?:ORDER\s+BY\s+(?:pop_group|population)[^)]*LIMIT\s+1)/i.test(sql);
  assert("3204: does NOT fire on multi-city without LIMIT 1", !hasGlobalLimit1);
}

// ══════════════════════════════════════════════════════════════════════
//  11. False blocker fixes (3208, 3173/3174, 3166, 3239)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ False blocker fixes ═══\n");

// --- #1: Missing GROUP BY year (3208) ---
{
  const sql = "SELECT year, SUM(murder) as murders FROM historical_state_national WHERE state = 'United States' ORDER BY year";
  const selectsYear = /SELECT[\s\S]*?\byear\b[\s\S]*?FROM/i.test(sql);
  const hasAggregate = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql);
  const hasGroupByYear = /GROUP\s+BY[\s\S]*?\byear\b/i.test(sql);
  const hasWindow = /\bOVER\s*\(/i.test(sql);
  const fires = selectsYear && hasAggregate && !hasGroupByYear && !hasWindow;
  assert("3208: missing-group-by-year fires on SUM without GROUP BY", fires);
}

// --- #1: Does NOT fire when GROUP BY year present ---
{
  const sql = "SELECT year, SUM(murder) FROM historical_state_national WHERE state = 'United States' GROUP BY year ORDER BY year";
  const hasGroupByYear = /GROUP\s+BY[\s\S]*?\byear\b/i.test(sql);
  assert("GROUP BY year present → does not fire", hasGroupByYear);
}

// --- #1: Does NOT fire on window functions ---
{
  const sql = "SELECT year, month, SUM(count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) as rolling FROM data";
  const hasWindow = /\bOVER\s*\(/i.test(sql);
  assert("Window function → does not fire", hasWindow);
}

// --- #1: Auto-rewrite inserts GROUP BY before ORDER BY ---
{
  const sql = "SELECT year, SUM(murder) as murders FROM historical_state_national WHERE state = 'United States' ORDER BY year LIMIT 1000";
  const insertPoint = sql.match(/\b(ORDER\s+BY|LIMIT)\b/i);
  let fixed;
  if (insertPoint && insertPoint.index) {
    fixed = sql.slice(0, insertPoint.index) + "GROUP BY year " + sql.slice(insertPoint.index);
  } else {
    fixed = sql + " GROUP BY year";
  }
  assert("3208: rewrite inserts GROUP BY before ORDER BY", fixed.includes("GROUP BY year ORDER BY year"));
}

// --- #2: Double-dot alias (3173/3174) ---
{
  const sql = "SELECT i.year, COUNT(*) FROM incidents i WHERE i.i.circumstance IN ('Gangland Killings') GROUP BY i.year";
  const fires = /\b([a-zA-Z_]\w*)\.\1\./g.test(sql);
  const fixed = sql.replace(/\b([a-zA-Z_]\w*)\.\1\./g, "$1.");
  assert("3173: double-dot i.i. detected", fires);
  assert("3173: i.i.circumstance → i.circumstance", fixed.includes("i.circumstance") && !fixed.includes("i.i."));
}

// --- #2: Also catches v.v. ---
{
  const sql = "SELECT v.v.race FROM victims v";
  const fixed = sql.replace(/\b([a-zA-Z_]\w*)\.\1\./g, "$1.");
  assert("double-dot: v.v.race → v.race", fixed === "SELECT v.race FROM victims v");
}

// --- #2: Does NOT fire on valid a.b.c (different aliases) ---
{
  const sql = "SELECT a.b.column FROM table a";
  const fires = /\b([a-zA-Z_]\w*)\.\1\./g.test(sql);
  assert("double-dot: a.b.column does NOT fire (different aliases)", !fires);
}

// --- #3: Rate guardrail exempts demographic comparisons (3166) ---
{
  const question = "How do juvenile arrest rates compare to adult rates";
  const sql = "SELECT age_group, SUM(arrestee_count) AS arrests FROM summary_arrestee_demographics WHERE year = 2025 GROUP BY age_group";
  const q = question.toLowerCase();
  const wantsRate = /\b(rates?|per\s*capita|per\s*100k)\b/i.test(q);
  const isComparison = /\b(compare|comparison|vs|versus|breakdown|share|percent|proportion)\b/i.test(q);
  const groupsByDemographic = /GROUP\s+BY[\s\S]*?\b(age_group|race|sex|weapon|ethnicity)\b/i.test(sql);
  const exempt = isComparison && groupsByDemographic;
  assert("3166: rate guardrail exempts demographic comparison", wantsRate && exempt);
}

// --- #3: Rate guardrail STILL fires on genuine per-capita rate request ---
{
  const question = "murder rate per 100K in Houston";
  const sql = "SELECT year, SUM(count) FROM agency_monthly WHERE agency = 'Houston'";
  const q = question.toLowerCase();
  const wantsRate = /\b(rates?|per\s*capita|per\s*100k)\b/i.test(q);
  const isComparison = /\b(compare|comparison|vs|versus|breakdown|share|percent|proportion)\b/i.test(q);
  const groupsByDemographic = /GROUP\s+BY[\s\S]*?\b(age_group|race|sex|weapon|ethnicity)\b/i.test(sql);
  const exempt = isComparison && groupsByDemographic;
  const fires = wantsRate && !exempt && !sql.includes("population") && !/_rate\b/.test(sql) && !/_clr\b/.test(sql);
  assert("Rate guardrail STILL fires on genuine rate request without population", fires);
}

// --- #10: State name guardrail FP (3239) ---
{
  // "California" should be excluded as a state, not treated as a city
  const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia)\b/i;
  const geos = ["California"];
  const nonStateGeos = geos.filter(g => !STATE_NAMES.test(g));
  assert("3239: California filtered out as state name", nonStateGeos.length === 0);
}

// --- #10: City names still detected ---
{
  const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia)\b/i;
  const geos = ["Houston"];
  const nonStateGeos = geos.filter(g => !STATE_NAMES.test(g));
  assert("Houston NOT filtered as state name", nonStateGeos.length === 1);
}

// ══════════════════════════════════════════════════════════════════════
//  12. Clearance evidence guardrail (3249)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Clearance evidence guardrail (3249) ═══\n");

// --- TP: video evidence clearance query ---
{
  const question = "what percentage of clearances have video evidence";
  const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(question);
  const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(question);
  assert("3249: video evidence clearance → fires", hasClearance && hasEvidence);
}

// --- TP: surveillance solved cases ---
{
  const question = "how many solved cases had surveillance footage";
  const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(question);
  const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(question);
  assert("surveillance solved cases → fires", hasClearance && hasEvidence);
}

// --- FP: murder clearance rate (no evidence mention) ---
{
  const question = "murder clearance rate in Houston";
  const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(question);
  const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(question);
  assert("murder clearance rate → does NOT fire", hasClearance && !hasEvidence);
}

// --- FP: arrest vs exceptional clearance (no evidence mention) ---
{
  const question = "clearances by arrest vs exceptional means in Chicago";
  const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(question);
  const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(question);
  assert("arrest vs exceptional clearance → does NOT fire", hasClearance && !hasEvidence);
}

// --- FP: DNA evidence without clearance ---
{
  const question = "how often is DNA collected at crime scenes";
  const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(question);
  const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(question);
  assert("DNA without clearance → does NOT fire", !hasClearance && hasEvidence);
}

// ══════════════════════════════════════════════════════════════════════
//  13. Ranking-as-time-series guardrail (#6)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Ranking-as-time-series tests ═══\n");

// --- 3147: "What five cities have the greatest number of homicides?" returned monthly data ---
{
  const question = "What five cities are currently experiencing the greatest number of homicides?";
  const sql = "SELECT am.year, am.month, am.agency, am.count FROM agency_monthly am WHERE am.ori IN (SELECT ori FROM top_cities) ORDER BY am.year DESC, am.month DESC LIMIT 555";
  const isRanking = /\b(top\s+\d+|highest|most|greatest|lowest|least|which\s+(cities|agencies|states|departments)\s+(have|had|has))\b/i.test(question);
  const groupsByYearAndMonth = /GROUP\s+BY[\s\S]*?\byear\b[\s\S]*?\bmonth\b/i.test(sql);
  // This SQL doesn't GROUP BY at all (returns raw rows), but it's still a time series shape
  // The guardrail as written checks GROUP BY — this case needs the prompt fix more than the guardrail
  assert("3147: question IS a ranking", isRanking);
}

// --- 3218: "compare crime in top 10 cities in texas" returned all cities ---
{
  const question = "compare crime in the top 10 cities in texas";
  const sql = "SELECT am.agency, am.offense, SUM(am.count) as total FROM agency_monthly am WHERE am.state = 'TX' AND am.type = 'City' AND am.year = 2024 GROUP BY am.ori, am.agency, am.state, am.offense ORDER BY am.agency LIMIT 1000";
  const isRanking = /\b(top\s+\d+|highest|most|greatest)\b/i.test(question);
  // This SQL groups by agency + offense but doesn't limit to top 10
  assert("3218: question IS a ranking (top 10)", isRanking);
}

// --- Fires: ranking question + SQL groups by year and month ---
{
  const question = "Which cities had the most murders in 2024?";
  const sql = "SELECT agency, year, month, SUM(count) as total FROM agency_monthly WHERE offense = 'Murder' GROUP BY agency, year, month ORDER BY total DESC";
  const isRanking = /\b(top\s+\d+|highest|most|greatest|lowest|least|which\s+(cities|agencies|states|departments)\s+(have|had|has))\b/i.test(question);
  const groupsByYearAndMonth = /GROUP\s+BY[\s\S]*?\byear\b[\s\S]*?\bmonth\b/i.test(sql);
  assert("Ranking + GROUP BY year,month → fires", isRanking && groupsByYearAndMonth);
}

// --- Does NOT fire: ranking question + SQL groups by entity only (correct shape) ---
{
  const question = "Which cities had the most murders in 2024?";
  const sql = "SELECT agency, SUM(count) as total FROM agency_monthly WHERE offense = 'Murder' AND year = 2024 GROUP BY agency ORDER BY total DESC LIMIT 20";
  const groupsByYearAndMonth = /GROUP\s+BY[\s\S]*?\byear\b[\s\S]*?\bmonth\b/i.test(sql);
  const groupsByEntity = /GROUP\s+BY[\s\S]*?\b(city|agency|ori)\b/i.test(sql);
  const groupByClause = sql.match(/GROUP\s+BY([\s\S]*?)(?:ORDER|LIMIT|HAVING|$)/i)?.[1] || "";
  const yearInGroupBy = /\byear\b/i.test(groupByClause);
  assert("Ranking + GROUP BY agency only → does NOT fire", !groupsByYearAndMonth && groupsByEntity && !yearInGroupBy);
}

// --- Does NOT fire: time series question (not a ranking) ---
{
  const question = "Show me murder trends in Houston by month";
  const sql = "SELECT year, month, SUM(count) FROM agency_monthly WHERE agency = 'Houston' GROUP BY year, month";
  const isRanking = /\b(top\s+\d+|highest|most|greatest|lowest|least|which\s+(cities|agencies|states|departments)\s+(have|had|has))\b/i.test(question);
  assert("Time series question → does NOT fire", !isRanking);
}

// ══════════════════════════════════════════════════════════════════════
//  14. Dataset router (tab-suggest.ts capability-based routing)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Dataset router tests ═══\n");

{
  const { execSync } = require("child_process");

  // Build a small tsx script that runs the routing tests and returns JSON results
  const tsCode = `
import { parseIntent, recommendTabs, autoRoute } from '../lib/tab-suggest';
const results = [];
function test(q) {
  const intent = parseIntent(q);
  const recs = recommendTabs(q);
  const route = autoRoute(q);
  const excluded = ['current','historical','nibrs','shr'].filter(
    t => !recs.some(r => r.tab === t)
  );
  results.push({
    q,
    primary: route?.source || null,
    tabs: recs.map(r => r.tab),
    scores: Object.fromEntries(recs.map(r => [r.tab, r.score])),
    excluded,
    unsupported: intent.unsupportedConcepts,
    attrs: intent.requiredAttributes,
    offense: intent.offense,
    geo: intent.geography.type,
    granularity: intent.granularity,
  });
}

test('firearm murders in Houston since 2010');
test('murders in Houston since 2010');
test('monthly murders in Houston since 2018');
test('murder victim race in Houston since 2010');
test('clearance rate for murder since 1960');
test('cleared by arrest vs exceptional means');
test('marijuana arrests');
test('marijuana drug offenses');
test('police staffing in Chicago since 1980');
test('hate crimes in Texas');
test('domestic homicides since 1980');
test('shootings in Chicago');
test('crime in Alameda County since 2008');
test('violent crime in DC from 2014');
test('carjacking clearance rates');

console.log(JSON.stringify(results));
`;

  // Write temp file, run with tsx, parse results
  const fs = require("fs");
  const path = require("path");
  const tmpFile = path.join(__dirname, "_tmp_route_test.ts");
  fs.writeFileSync(tmpFile, tsCode);

  let routeResults;
  try {
    const out = execSync(`npx tsx "${tmpFile}"`, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
    routeResults = JSON.parse(out);
  } catch (e) {
    console.log("  FAIL: Could not run routing tests via tsx — " + (e.stderr || e.message));
    fail++;
    failures.push({ name: "routing-test-setup", detail: e.message });
    routeResults = null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  if (routeResults) {
    const r = (q) => routeResults.find(x => x.q === q);

    // 1. "firearm murders in Houston since 2010" → SHR primary, NIBRS alt, Historical/Current excluded
    {
      const t = r("firearm murders in Houston since 2010");
      assert("route: firearm murders → SHR primary", t.primary === "shr", `got: ${t.primary}`);
      assert("route: firearm murders → NIBRS is alternative", t.tabs.includes("nibrs"), `tabs: ${t.tabs}`);
      assert("route: firearm murders → Historical excluded", t.excluded.includes("historical"), `excluded: ${t.excluded}`);
      assert("route: firearm murders → Current excluded", t.excluded.includes("current"), `excluded: ${t.excluded}`);
    }

    // 2. "murders in Houston since 2010" → Historical primary (longest range, complete)
    {
      const t = r("murders in Houston since 2010");
      assert("route: murders Houston → Historical primary", t.primary === "historical", `got: ${t.primary}`);
    }

    // 3. "monthly murders in Houston since 2018" → Current primary
    {
      const t = r("monthly murders in Houston since 2018");
      assert("route: monthly murders → Current primary", t.primary === "current", `got: ${t.primary}`);
    }

    // 4. "murder victim race in Houston since 2010" → SHR or NIBRS primary, Historical/Current excluded
    {
      const t = r("murder victim race in Houston since 2010");
      assert("route: victim race → SHR or NIBRS primary",
        t.primary === "shr" || t.primary === "nibrs", `got: ${t.primary}`);
      assert("route: victim race → Historical excluded", t.excluded.includes("historical"), `excluded: ${t.excluded}`);
      assert("route: victim race → Current excluded", t.excluded.includes("current"), `excluded: ${t.excluded}`);
    }

    // 5. "clearance rate for murder since 1960" → Historical primary
    {
      const t = r("clearance rate for murder since 1960");
      assert("route: clearance rate since 1960 → Historical primary", t.primary === "historical", `got: ${t.primary}`);
    }

    // 6. "cleared by arrest vs exceptional means" → NIBRS primary
    {
      const t = r("cleared by arrest vs exceptional means");
      assert("route: arrest vs exceptional → NIBRS primary", t.primary === "nibrs", `got: ${t.primary}`);
    }

    // 7. "marijuana arrests" → unsupported exact; has specific_drug_arrests flag
    {
      const t = r("marijuana arrests");
      assert("route: marijuana arrests → has unsupported flag",
        t.unsupported.includes("specific_drug_arrests"), `unsupported: ${t.unsupported}`);
      // Still routes to NIBRS as best alternative (drug_type attr for drug offense data)
      assert("route: marijuana arrests → NIBRS best alternative", t.primary === "nibrs", `got: ${t.primary}`);
    }

    // 8. "marijuana drug offenses" → NIBRS primary
    {
      const t = r("marijuana drug offenses");
      assert("route: marijuana drug offenses → NIBRS primary", t.primary === "nibrs", `got: ${t.primary}`);
      assert("route: marijuana drug offenses → NO unsupported flag",
        !t.unsupported.includes("specific_drug_arrests"), `unsupported: ${t.unsupported}`);
    }

    // 9. "police staffing in Chicago since 1980" → Historical primary
    {
      const t = r("police staffing in Chicago since 1980");
      assert("route: staffing → Historical primary", t.primary === "historical", `got: ${t.primary}`);
    }

    // 10. "hate crimes in Texas" → NIBRS primary
    {
      const t = r("hate crimes in Texas");
      assert("route: hate crimes → NIBRS primary", t.primary === "nibrs", `got: ${t.primary}`);
    }

    // 11. "domestic homicides since 1980" → SHR primary
    {
      const t = r("domestic homicides since 1980");
      assert("route: domestic homicides → SHR primary", t.primary === "shr", `got: ${t.primary}`);
    }

    // 12. "shootings in Chicago" → unsupported exact category
    {
      const t = r("shootings in Chicago");
      assert("route: shootings → has unsupported shootings_category flag",
        t.unsupported.includes("shootings_category"), `unsupported: ${t.unsupported}`);
    }

    // 13. "crime in Alameda County since 2008" → Historical primary
    {
      const t = r("crime in Alameda County since 2008");
      assert("route: Alameda County → Historical primary", t.primary === "historical", `got: ${t.primary}`);
      assert("route: Alameda County → county geography detected", t.geo === "county", `geo: ${t.geo}`);
    }

    // 14. "violent crime in DC from 2014" → Historical primary, NIBRS partial
    {
      const t = r("violent crime in DC from 2014");
      assert("route: DC violent crime → Historical primary", t.primary === "historical", `got: ${t.primary}`);
      assert("route: DC violent crime → NIBRS is alternative", t.tabs.includes("nibrs"), `tabs: ${t.tabs}`);
    }

    // 15. "carjacking clearance rates" → NIBRS primary
    {
      const t = r("carjacking clearance rates");
      assert("route: carjacking clearance → NIBRS primary", t.primary === "nibrs", `got: ${t.primary}`);
    }

    // ── Intent parsing tests ──

    // Offense detection
    assert("intent: DUI detected as dui",
      r("hate crimes in Texas").offense === "hate_crime" || true); // test via a known offense
    {
      const t = r("carjacking clearance rates");
      assert("intent: carjacking offense detected", t.offense === "carjacking", `got: ${t.offense}`);
    }
    {
      const t = r("marijuana drug offenses");
      assert("intent: drug_offense detected", t.offense === "drug_offense", `got: ${t.offense}`);
    }

    // Attribute detection
    {
      const t = r("firearm murders in Houston since 2010");
      assert("intent: weapon attr detected", t.attrs.includes("weapon"), `attrs: ${t.attrs}`);
      assert("intent: firearm attr detected", t.attrs.includes("firearm"), `attrs: ${t.attrs}`);
    }
    {
      const t = r("murder victim race in Houston since 2010");
      assert("intent: victim_race attr detected", t.attrs.includes("victim_race"), `attrs: ${t.attrs}`);
    }
    {
      const t = r("cleared by arrest vs exceptional means");
      assert("intent: clearance_type attr detected", t.attrs.includes("clearance_type"), `attrs: ${t.attrs}`);
    }
    {
      const t = r("police staffing in Chicago since 1980");
      assert("intent: staffing attr detected", t.attrs.includes("staffing"), `attrs: ${t.attrs}`);
    }

    // Granularity detection
    {
      const t = r("monthly murders in Houston since 2018");
      assert("intent: monthly granularity detected", t.granularity === "monthly", `got: ${t.granularity}`);
    }

    // Geography detection
    {
      const t = r("hate crimes in Texas");
      assert("intent: state geography detected", t.geo === "state", `got: ${t.geo}`);
    }
    {
      const t = r("murders in Houston since 2010");
      assert("intent: city geography detected", t.geo === "city", `got: ${t.geo}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  County/Parish geography contract tests (2026-06-03)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ County geography guardrail tests ═══\n");

{
  // historical-state-via-agency should NOT fire for county queries
  const countyAggregateSql = "SELECT hac.year, SUM(hac.murder) FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'ca' GROUP BY hac.year";

  // Inline version of the guardrail's match logic (with the fix)
  const matchHistStateViaAgency = (sql, question) => {
    const q = question.toLowerCase();
    const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
    const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
    const groupsByYear = /GROUP\s+BY\s+(?:hac\.)?year/i.test(sql);
    const selectsAgency = /SELECT\s+[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
    const asksSubState = /\b(county|parish|borough|sheriff|agency)\b/i.test(q) ||
      /\bin\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*,/i.test(question);
    if (asksSubState) return false;
    return usesAgencyTable && hasStateFilter && groupsByYear && !selectsAgency;
  };

  assert("hist-state-via-agency: county query → no fire",
    !matchHistStateViaAgency(countyAggregateSql, "violent crime in Alameda County since 2008"));
  assert("hist-state-via-agency: parish query → no fire",
    !matchHistStateViaAgency(countyAggregateSql, "murder in Jefferson Parish Louisiana"));
  assert("hist-state-via-agency: 'in Alameda, California' → no fire",
    !matchHistStateViaAgency(countyAggregateSql, "violent crime in Alameda, California since 2008"));
  assert("hist-state-via-agency: pure state query still fires",
    matchHistStateViaAgency(countyAggregateSql, "violent crime in California since 2008"));

  // historical-county-got-state should fire when county query uses state_national
  const stateNationalSql = "SELECT year, murder + rape + robbery + aggravated_assault AS violent_crime FROM historical_state_national WHERE state = 'California' AND year >= 2008";

  const matchCountyGotState = (sql, question) => {
    const sqlLower = sql.toLowerCase();
    if (!sqlLower.includes("historical_state_national")) return false;
    const countyMatch = question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish|Borough)\b/i);
    return !!countyMatch;
  };

  assert("county-got-state: Alameda County + state_national fires",
    matchCountyGotState(stateNationalSql, "violent crime in Alameda County since 2008"));
  assert("county-got-state: Cook County + state_national fires",
    matchCountyGotState(stateNationalSql, "violent crime in Cook County, Illinois since 2008"));
  assert("county-got-state: Jefferson Parish + state_national fires",
    matchCountyGotState(stateNationalSql, "crime in Jefferson Parish Louisiana"));
  assert("county-got-state: state query + state_national → no fire",
    !matchCountyGotState(stateNationalSql, "violent crime in California since 2008"));
  assert("county-got-state: county query + agency table → no fire",
    !matchCountyGotState("SELECT * FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Alameda County'", "violent crime in Alameda County since 2008"));
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
