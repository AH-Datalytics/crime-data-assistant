/*
 * GC-098 — the disclosed Baltimore-city default in a Historical two-place comparison.
 *
 * The saved run asked "Baltimore city or Baltimore County?" before any model call, for "Compare the
 * total annual number of homicides in Baltimore and Chicago over the past 10 years". Codex's design
 * ruling (2026-09-26, option A, Historical only) makes one exception to that question: bare
 * Baltimore compared with one other unambiguous city means Baltimore city, and the answer says so.
 *
 * Three things are held here:
 *   1. the rule itself, and the controls that bound it (explicit city/county, standalone, an
 *      unresolved other city, Washington, a city merely mentioned elsewhere, three places);
 *   2. PLACEMENT in the Historical route: the effective request replaces `question` before the
 *      geographic gate reads it, the log keeps what was typed, and every exit that can answer a
 *      two-city comparison carries the application-owned disclosure;
 *   3. the Historical prompt: the standalone rule and this exception agree.
 * Delivered answers through the real route are proved by
 * audit/phase3-gc084-gc098-2026-09-26/delivery-witness.cjs.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { readFileSync } from "fs";
import {
  historicalBaltimoreComparisonDefault,
  withBaltimoreDisclosure,
  withoutBaltimoreDisclosure,
  BALTIMORE_COMPARISON_DISCLOSURE,
} from "../lib/historical-baltimore-comparison";
import { getBlockingGeoClarification } from "../lib/geo-resolver";
import { resolveGeoPlaces } from "../lib/geo-place-resolver";
import { buildQueryContract } from "../lib/query-contract";
import { getHistoricalSystemPrompt } from "../lib/claude";
import Database from "better-sqlite3";
import { buildMultiCityTrendPlan, relativePeriodShortfallNote } from "../lib/multi-city-deterministic";
import { relativeYearRangeForQuestion } from "../lib/time-conventions";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const GC098 = "Compare the total annual number of homicides in Baltimore and Chicago over the past 10 years";

console.log("\n1 - the saved GC-098 request gets the city default, and only Baltimore changes");
{
  const d = historicalBaltimoreComparisonDefault(GC098);
  check(d?.effectiveQuestion === "Compare the total annual number of homicides in Baltimore city and Chicago over the past 10 years",
    "Baltimore becomes 'Baltimore city'; every other word, including the relative period, is kept");
  check(d?.disclosure === BALTIMORE_COMPARISON_DISCLOSURE
    && /Baltimore city, the Baltimore Police Department, not Baltimore County/.test(d.disclosure)
    && /default/.test(d.disclosure),
    "the disclosure names the city agency, rules out the county, and calls itself a default");
  check(getBlockingGeoClarification(GC098) !== null && getBlockingGeoClarification(d!.effectiveQuestion) === null,
    "the original asks; the effective request leaves no geographic question");
  const contract = buildQueryContract(d!.effectiveQuestion, "historical");
  check(contract?.geographies.length === 2, "the contract built from the effective request carries both places");
}

console.log("\n2 - other direct comparison shapes");
for (const q of [
  "Compare homicides in Baltimore vs. Chicago since 2015",
  "Compare homicides in Chicago and Baltimore since 2015",
  "homicides in Baltimore versus Chicago since 2015",
  "Compare murders between Baltimore and Chicago from 2015 to 2024",
]) check(historicalBaltimoreComparisonDefault(q) !== null, `default applies: "${q}"`);

console.log("\n3 - the controls: no default, so the existing question still asks");
const controls: [string, string][] = [
  ["explicit city", "Compare homicides in Baltimore city and Chicago over the past 10 years"],
  ["explicit county", "Compare homicides in Baltimore County and Chicago over the past 10 years"],
  ["standalone", "murder rate in Baltimore since 2010"],
  ["unresolved other city", "Compare homicides in Baltimore and Portland over the past 10 years"],
  ["other place also ambiguous", "Compare homicides in Baltimore and Washington"],
  ["another city merely mentioned (exactly two places, not joined)", "Compare homicides in Baltimore over the past 10 years, as reported in Chicago newspapers"],
  ["no comparison word", "homicides in Baltimore and Chicago over the past 10 years"],
  ["three places", "Compare homicides in Baltimore, Chicago and Detroit"],
  ["Washington alone", "murder rate in Washington since 2010"],
];
for (const [what, q] of controls) check(historicalBaltimoreComparisonDefault(q) === null, `${what}: no default`);
// Kept distinguishable: an earlier wording ("my friend lives in Chicago") also matched Friend, NE,
// so the two-place rule rejected it and the joiner rule was never exercised.
check(resolveGeoPlaces(controls[5][1]).mentions.length === 2, "the merely-mentioned control has exactly two places, so only the joiner rule can reject it");
check(getBlockingGeoClarification("Compare homicides in Baltimore and Portland over the past 10 years")?.issue.id === "baltimore",
  "an unresolved other city: Baltimore is still asked about, and Portland is not erased");

console.log("\n4 - the disclosure helpers");
{
  const d = historicalBaltimoreComparisonDefault(GC098)!;
  const once = withBaltimoreDisclosure("Annual counts.", d);
  check(once.endsWith(d.disclosure) && withBaltimoreDisclosure(once, d) === once, "appended once; reapplying does not repeat it");
  check(withBaltimoreDisclosure("Annual counts.", null) === "Annual counts.", "no default, no change");
  check(withoutBaltimoreDisclosure(once, d) === "Annual counts.", "taken back out before a rewrite step, then appended once after");
}

console.log("\n5 - placement in the Historical route");
{
  const route = readFileSync("app/api/query/route.ts", "utf8");
  const defaultAt = route.indexOf("const baltimoreDefault = tab === \"historical\" ? historicalBaltimoreComparisonDefault(question) : null;");
  const replaceAt = route.indexOf("if (baltimoreDefault) question = baltimoreDefault.effectiveQuestion;");
  const firstGeoGate = route.indexOf("getBlockingGeoClarification(question)");
  const firstBuilder = route.indexOf("detectSubCityGeographyOverride(question)");
  check(defaultAt > 0 && replaceAt > defaultAt, "the default is computed for the Historical tab only and replaces `question`");
  check(replaceAt < firstGeoGate && replaceAt < firstBuilder && replaceAt < route.indexOf("let proofQuestion = question;"),
    "before the geographic gate, the first deterministic builder and the proof question read it");
  check(route.includes("const recordedQuestion = question;") && route.includes("logQuery(q === question ? recordedQuestion : q,"),
    "the query log keeps what the user typed");
  check(route.includes("multiCityTrend.explanation = withBaltimoreDisclosure(periodExplanation, baltimoreDefault);")
    && route.includes("explanation: multiCityTrend.explanation || presentation.explanation,"),
    "the multi-city comparison exit delivers the disclosure");
  check(route.includes("if (historicalCityChange && baltimoreDefault) historicalCityChange.explanation = withBaltimoreDisclosure("),
    "the Historical change/peer/ranking exit delivers it");
  check(route.includes("if (baltimoreDefault) claude.explanation = withBaltimoreDisclosure(claude.explanation || \"\", baltimoreDefault);")
    && route.indexOf("if (baltimoreDefault) claude.explanation = withBaltimoreDisclosure(") < route.indexOf("const finalization = finalizeExit({\n          intendedAction: \"answer\","),
    "the model path's first factual event carries it, before proof finalization");
  check(route.includes("postExplanation = withReliabilityNote(postExplanation);\n          postExplanation = withBaltimoreDisclosure(postExplanation, baltimoreDefault);")
    && route.includes("retryExplanation = withReliabilityNote(retryExplanation);\n            retryExplanation = withBaltimoreDisclosure(retryExplanation, baltimoreDefault);"),
    "the refined and retry explanations reapply it, after the reliability note (left as it was)");
  check((route.match(/preQueryExplanation: withoutBaltimoreDisclosure\(claude\.explanation, baltimoreDefault\),/g) ?? []).length === 2,
    "both explanation rewrites start from text without it, so it is not edited and duplicated");
}

console.log("\n6 - the Historical prompt agrees with the exception");
{
  const prompt = getHistoricalSystemPrompt();
  check(/If the user says just "Baltimore" or "St\. Louis" without specifying, set sql to null and ask which jurisdiction they mean\./.test(prompt),
    "standalone bare Baltimore still asks");
  check(/One exception is made by the application, not by you: when bare Baltimore is compared with one other city, the application rewrites the request to "Baltimore city"/.test(prompt)
    && /A request that says "Baltimore city" is specified/.test(prompt),
    "the application-made exception is stated, and 'Baltimore city' counts as specified");
  check(/"Baltimore city" is specified \(see rule 9/.test(prompt), "the pre-SQL ambiguity rule points to the same exception");
}

console.log("\n7 - correction C1: the requested relative period is what executes");
{
  const effective = historicalBaltimoreComparisonDefault(GC098)!.effectiveQuestion;
  const expected = relativeYearRangeForQuestion(GC098)!;
  const plan = buildMultiCityTrendPlan(effective, "historical")!;
  check(expected.end - expected.start + 1 === 10 && expected.end === new Date().getFullYear() - 1,
    `"past 10 years" resolves by the shared convention to the last 10 complete years (${expected.start}-${expected.end})`);
  check(plan.sql.includes(`hac.year BETWEEN ${expected.start} AND ${expected.end}`) && !plan.sql.includes("1 = 1"),
    "the executed statement filters to that period (it used to be WHERE 1 = 1)");
  check(plan.title.endsWith(`${expected.start}-${expected.end}`) && !/All Available Years/.test(plan.title), `the title names it: "${plan.title}"`);
  check(plan.explanation.includes(`from ${expected.start} through ${expected.end} (the requested last 10 complete calendar years)`), "and so does the explanation");
  check(plan.relativePeriod?.start === expected.start && plan.relativePeriod?.end === expected.end, "the plan carries the resolved period to the exit");

  // Executed against rows on both sides of the period.
  const hdb = new Database(":memory:");
  hdb.exec(`CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT);
    CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, population INTEGER, murder INTEGER);
    CREATE TABLE historical_agency_population (ori TEXT, year INTEGER, population INTEGER);
    INSERT INTO historical_agency VALUES ('MDBPD0000','Baltimore','md','city'),('MD0030100','Baltimore County','md','county'),('ILCPD0000','Chicago','il','city');`);
  const put = hdb.prepare("INSERT INTO historical_agency_crime VALUES (?,?,1,?)");
  for (let year = expected.start - 2; year <= expected.end + 1; year++) { put.run("MDBPD0000", year, year); put.run("MD0030100", year, 1); put.run("ILCPD0000", year, year + 1); }
  const rows = hdb.prepare(plan.sql).all() as Record<string, unknown>[];
  hdb.close();
  check(rows.length === 10 && rows[0].year === expected.start && rows[9].year === expected.end,
    "out-of-range years on both sides are excluded; exactly the 10 requested years return");
  check(rows.every((row) => row.baltimore === row.year), "Baltimore is the city series (the county decoy never appears)");
  check(relativePeriodShortfallNote(plan, rows) === null, "full coverage: no shortfall sentence");
  const short = rows.filter((row) => Number(row.year) < expected.end);
  check(relativePeriodShortfallNote(plan, short) === `The requested period is ${expected.start}-${expected.end}; the rows returned cover ${expected.start}-${expected.end - 1}, so ${expected.end} is not included.`,
    "rows ending a year early: the answer says the final year is not included, rather than silently shortening");

  const explicit = buildMultiCityTrendPlan("Compare homicides in Baltimore city and Chicago from 2017 to 2019", "historical")!;
  check(explicit.sql.includes("hac.year BETWEEN 2017 AND 2019") && explicit.title.endsWith("2017-2019") && explicit.relativePeriod === undefined,
    "explicit years behave as before (no relative period, no shortfall sentence)");
  check(buildMultiCityTrendPlan("Compare homicides in Chicago and Detroit over the past 10 years", "current") === null,
    "the Current branch is unchanged: a relative period still does not build there");
  check(buildMultiCityTrendPlan("Compare homicides in Chicago and Detroit from 2023 to 2025", "current")?.sql.includes("am.year BETWEEN 2023 AND 2025") === true,
    "and explicit Current years still build as before");
  const now = new Date().getFullYear();
  const including = buildMultiCityTrendPlan("Compare homicides in Baltimore city and Chicago over the past 5 years including this year", "historical")!;
  check(including.sql.includes(`hac.year BETWEEN ${now - 4} AND ${now}`) && including.explanation.includes(`including ${now}, which is partial`),
    "the including-this-year form keeps the convention and says the current year is partial");

  const route = readFileSync("app/api/query/route.ts", "utf8");
  check(route.includes("const periodShortfall = relativePeriodShortfallNote(multiCityTrend, rows);")
    && route.indexOf("relativePeriodShortfallNote(multiCityTrend, rows)") < route.indexOf("multiCityTrend.explanation = withBaltimoreDisclosure(periodExplanation, baltimoreDefault);"),
    "the multi-city exit states any shortfall before the Baltimore disclosure");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
