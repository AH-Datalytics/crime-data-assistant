/*
 * Request accounting, stage 2a (Historical), plan r1.1 task 2: the Historical vocabulary and ledger
 * (lib/historical-request-accounting.ts). Paired cases: a supported wording and its neighbor that must be read
 * differently. No database, no route.
 */
import "./offline-evidence-guard";
import { accountHistoricalRequest, historicalRecognitionRefusal, historicalRequestKind, historicalFollowupCheck, thresholdValue } from "../lib/historical-request-accounting";
import { isFollowUp } from "../lib/tab-suggest";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}
const parts = (q: string) => accountHistoricalRequest(q).parts.filter((p) => p.state !== "context");
const has = (q: string, concept: string, value?: string) => parts(q).some((p) => p.concept === concept && (value === undefined || p.value === value));
const refused = (q: string) => historicalRecognitionRefusal(accountHistoricalRequest(q));

// ---- every character is accounted for, and a supported question has no refusal ----
for (const q of [
  "murders in Fort Worth, Texas from 2018 to 2023",
  "violent crime rate in Ohio from 2018 to 2020",
  "top 3 cities in Texas by murder rate in 2021 with at least 100,000 people",
  "change in murders in Fort Worth, Texas from 2019 to 2023",
  "murder rate by state and year from 2018 to 2020",
  "sworn officers in Fort Worth, Texas from 2018 to 2022",
  "national murder clearance rate from 2020 to 2023",
  "How has violent crime changed in the last year in Washington D.C.?",
]) {
  const l = accountHistoricalRequest(q);
  check(l.undischarged().length === 0 && l.residue().length === 0, `ledger covers every character: ${q}`);
  check(historicalRecognitionRefusal(l) === null, `no recognition refusal: ${q}`);
}

// ---- paired readings ----
check(has("total crime in Ohio in 2021", "measure", "total") && !has("total crime in Ohio in 2021", "combine"), "\"total crime\" is the measure total crime");
check(has("total murders in Ohio from 2015 to 2020", "combine") && has("total murders in Ohio from 2015 to 2020", "measure", "murder"), "\"total murders 2015-2020\" is a period total of murders");
check(has("murders in Fort Worth, Texas from 2019 to 2023", "period", "range:2019:2023") && !has("murders in Fort Worth, Texas from 2019 to 2023", "change"), "\"from 2019 to 2023\" alone is a range");
check(has("change in murders in Fort Worth, Texas from 2019 to 2023", "change"), "with a change word it is a change");
check(has("Fort Worth, Texas murders 2023 vs 2019", "versus") && has("Fort Worth, Texas murders 2023 vs 2019", "period", "year:2023") && has("Fort Worth, Texas murders 2023 vs 2019", "period", "year:2019"), "\"2023 vs 2019\" keeps both years and the comparison word");
check(has("sexual assaults in Columbus, Ohio in 2020", "measure", "rape"), "sexual assault is the UCR rape measure");
check(has("assaults in Columbus, Ohio in 2020", "measure", "aggravated_assault"), "assault alone is aggravated assault");
check(has("murders per capita in Columbus, Ohio in 2021", "statistic", "percapita") && has("officers per capita in Columbus, Ohio in 2021", "statistic", "percapita"), "per capita is recorded the same for crime and staffing (the type decides the scale)");
check(has("murders in Columbus, Ohio last year", "period", "lastyear") && has("murders in Columbus, Ohio in the latest year", "period", "latest"), "last year (calendar) vs latest year (data) are different values");
check(has("car thefts in Ohio in 2020", "measure", "motor_vehicle_theft") && !has("car thefts in Ohio in 2020", "measure", "theft"), "car theft is motor vehicle theft, not theft");
check(has("murders in White Plains, New York in 2020", "place") && !refused("murders in White Plains, New York in 2020"), "a place name is claimed before a demographic word (White Plains)");
check(has("Are there any large cities where car thefts did not increase in the early 2020's?", "period-unsupported") && !has("Are there any large cities where car thefts did not increase in the early 2020's?", "place", "city:Early:TX"), "\"early 2020's\" is a period, not Early, TX");
check(has("what is seattle's 2026 per capita murder rate", "place", "city:Seattle:WA"), "a possessive place resolves");
check(has("top 10 us cities by homicide rate in 2021", "place", "national"), "lowercase \"us\" before cities is national");

// ---- wordings the fixed paths already answered (usefulness run): never declined for vocabulary ----
check(!refused("Compare murders between Baltimore city and Chicago from 2015 to 2024"), "\"between\" two named places is a connector");
check(has("homicide rates in Boston and Chicago from. 2022 to 2025", "period", "range:2022:2025") && !refused("homicide rates in Boston and Chicago from. 2022 to 2025"), "\"from.\" before a year range is the range");
check(has("Compare homicides in Baltimore city and Chicago over the past 5 years including this year", "period", "lastinc:5"), "\"past 5 years including this year\" keeps the including-this-year reading");
check(has("murders between 2019 and 2021 in Ohio", "period", "between:2019:2021"), "\"between\" two years stays a period");

// ---- r2: change direction, "at least" is not a rank word, one numeric-ask rule ----
check(has("cities with the largest increase in violent crime from 2020 to 2023", "change", "change:increase") && has("cities with the largest drop in violent crime from 2020 to 2023", "change", "change:decrease") && has("largest change in violent crime from 2020 to 2023", "change", "change:neutral"), "change words record their direction");
check(!has("theories supported by at least some academics", "rank"), "\"at least\" with no number is not a rank word");
check(historicalRequestKind(accountHistoricalRequest("Why, and how many murders in Ohio in 2021?")) === "numeric", "an explicit numeric ask is answered even when why comes first");
check(historicalRequestKind(accountHistoricalRequest("why the murder rate in Ohio in 2021")) === "numeric", "a stated statistic is a numeric ask");
check(historicalFollowupCheck({ question: "what about murder rate in 2022?", reconstructed: "murders in Columbus, Ohio in 2022", previousUserTurns: ["murders in Columbus, Ohio in 2021"], isFollowUp }) !== null, "K2: a statistic this turn adds must reach the reconstruction");
check(/gun/.test(historicalFollowupCheck({ question: "what about gun murders in 2022?", reconstructed: "murders in Columbus, Ohio in 2022", previousUserTurns: ["murders in Columbus, Ohio in 2021"], isFollowUp })?.explanation ?? ""), "K2: an unsupported word this turn adds is named, not dropped");

// ---- thresholds: operator and exact token kept ----
check(thresholdValue("with at least 100,000 people") === ">=|100000" && thresholdValue("with at least 100k people") === ">=|100000", "at least 100,000 and 100k resolve to one key");
check(thresholdValue("with over 100,000 people") === ">|100000", "over is strict");
check(thresholdValue("with under 200,000 people") === "max|200000", "under is a maximum");
check(thresholdValue("with at least 9007199254740993 people") === ">=|9007199254740993", "an unsafe amount keeps its exact token");

// ---- recognition refusals: not recorded vs not interpreted ----
for (const [q, word, kind] of [
  ["gun murders in Fort Worth, Texas in 2022", "gun", "not-recorded"],
  ["juvenile robberies in Columbus, Ohio in 2021", "juvenile", "not-recorded"],
  ["arrests in Columbus, Ohio in 2021", "arrests", "not-recorded"],
  ["murders by zip code in Chicago", "zip code", "not-recorded"],
  ["murders in Fort Worth, Texas in March 2022", "March", "not-recorded"],
  ["murders via banana in Fort Worth, Texas in 2022", "banana", "not-interpreted"],
  ["murders for ORI TXFTW0000 in 2022", "ORI", "not-interpreted"],
  ["top 3 large cities in Texas by murders in 2021", "large", "not-interpreted"],
] as const) {
  const r = refused(q);
  check(Boolean(r && r.parts.some((p) => p.state === kind) && r.explanation.includes(word)), `${kind} names "${word}": ${q}`);
}
check(/couldn't interpret "via banana in"/.test(refused("murders via banana in Fort Worth, Texas in 2022")?.explanation ?? ""), "adjacent unknown words are named once as a phrase");
check(/doesn't record weapons/.test(refused("gun murders in Fort Worth, Texas in 2022")?.explanation ?? "") && !/couldn't interpret/.test(refused("gun murders in Fort Worth, Texas in 2022")?.explanation ?? ""), "not-recorded wording is not the not-interpreted wording");

// ---- text vs numeric ----
check(historicalRequestKind(accountHistoricalRequest("why the increase?")) === "text", "why the increase? is a text request");
check(historicalRequestKind(accountHistoricalRequest("Why has crime dropped recently? Theories please")) === "text", "a turn opening with why is text");
check(historicalRequestKind(accountHistoricalRequest("how many murders were there in Columbus, Ohio in 2021 and why?")) === "numeric", "a number asked first stays numeric");
check(accountHistoricalRequest("how many murders were there in Columbus, Ohio in 2021 and why?").parts.some((p) => p.concept === "explain" && p.clause === 1), "the why part is clause 1");
check(historicalRequestKind(accountHistoricalRequest("Fort Worth, Texas")) === "numeric", "a bare place is the coverage lookup's (numeric) request");

// ---- K2 follow-ups ----
const prev = ["top 3 cities in Texas by murder rate in 2021 with at least 100,000 people"];
check(historicalFollowupCheck({ question: "what about 2022?", reconstructed: "top 3 cities in Texas by murder rate in 2022 with at least 100,000 people", previousUserTurns: prev, isFollowUp }) === null, "K2: a replaced year with every restriction carried is accepted");
check(/with at least 100,000 people/.test(historicalFollowupCheck({ question: "what about 2022?", reconstructed: "top 3 cities in Texas by murder rate in 2022", previousUserTurns: prev, isFollowUp })?.explanation ?? ""), "K2: a dropped threshold is declined by name");
check(/"in 2022"|2022/.test(historicalFollowupCheck({ question: "what about 2022?", reconstructed: "top 3 cities in Texas by murder rate in 2021 with at least 100,000 people", previousUserTurns: prev, isFollowUp })?.explanation ?? ""), "K2: a reconstruction that ignores the replacement is declined");
check(/complete question/.test(historicalFollowupCheck({ question: "and 2023?", reconstructed: "top 3 cities in Texas by murder rate in 2023 with at least 100,000 people", previousUserTurns: [...prev, "what about 2022?"], isFollowUp })?.explanation ?? ""), "K2: a follow-up to a follow-up is declined whatever the reconstruction");
check(/complete question/.test(historicalFollowupCheck({ question: "what about Dallas?", reconstructed: null, previousUserTurns: ["murders in Houston since 2010"], isFollowUp })?.explanation ?? ""), "K2: no reconstruction is declined");
check(/since 2021/.test(historicalFollowupCheck({ question: "what about Fort Worth, Texas?", reconstructed: "murders in Fort Worth, Texas", previousUserTurns: ["murders in Columbus, Ohio since 2021"], isFollowUp })?.explanation ?? ""), "K2: a dropped period is declined by name");

// Complete-turn fix (2026-10-23): agency names and the agency noun after a city-or-county name.
{
  const placeOf = (q: string) => accountHistoricalRequest(q).parts.filter((p) => p.concept === "place").map((p) => p.value).join();
  check(placeOf("LAPD murder clearance rate since 1960") === "city:Los Angeles:CA", "LAPD is the Los Angeles city agency");
  check(placeOf("Los Angeles Police Department murder clearance rate since 1960") === "city:Los Angeles:CA", "the department name is the city agency, not ambiguous");
  check(placeOf("Los Angeles murder clearance rate since 1960") === "ambiguous:Los Angeles", "bare Los Angeles stays ambiguous");
  check(placeOf("Sacramento Sheriff murders since 2000").startsWith("county:Sacramento"), "a sheriff after a city-or-county name is the county");
  check(placeOf("Sacramento Police Department murders since 2000").startsWith("city:Sacramento"), "a police department after a city-or-county name is the city");
  check(placeOf("Portland Police Department murders since 2000") === "ambiguous:Portland", "two cities of that name stay ambiguous");
  const xyz = historicalRecognitionRefusal(accountHistoricalRequest("XYZPD murder clearance rate since 1960"));
  check(xyz?.parts.map((p) => p.text).join() === "XYZPD", "an unknown acronym is named, never guessed");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
