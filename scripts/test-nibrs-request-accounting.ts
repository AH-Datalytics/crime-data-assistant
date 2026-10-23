/*
 * Request accounting, stage 2b (NIBRS), plan r1.1 tasks 2 and 4: the NIBRS vocabulary and ledger
 * (lib/nibrs-request-accounting.ts), the per-dimension follow-up check (r1.1 R1), and fixed-path binding by value
 * (lib/nibrs-legacy-binding.ts, L1-L3). Paired cases: a supported wording and its neighbor that must be read differently.
 * No database, no route.
 */
import "./offline-evidence-guard";
import { accountNibrsRequest, nibrsRecognitionRefusal, nibrsRequestKind, nibrsFollowupCheck, followupKey, resolveNibrsPeriodReplacement } from "../lib/nibrs-request-accounting";
import { nibrsLegacyBound, nibrsUnboundParts, placeIs, expandCodes, periodRange } from "../lib/nibrs-legacy-binding";
import { isFollowUp } from "../lib/tab-suggest";
import { demographicMissingYearsNote } from "../lib/nibrs-deterministic-queries";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}
const parts = (q: string) => accountNibrsRequest(q).parts.filter((p) => p.state !== "context");
const has = (q: string, concept: string, value?: string) => parts(q).some((p) => p.concept === concept && (value === undefined || p.value === value));
const refused = (q: string) => nibrsRecognitionRefusal(accountNibrsRequest(q));

// ---- every character is accounted for, and a supported question has no refusal ----
for (const q of [
  "How many robberies were reported in Fort Worth, Texas in 2025?",
  "robbery offenders in Fort Worth, Texas in 2025 by age group",
  "rolling 12-month robberies in Fort Worth, Texas for 2025",
  "what share of robbery offenders in Fort Worth, Texas were under 18 in 2025?",
  "top 3 cities in Texas with at least 100,000 people by murder clearance rate in 2025",
  "domestic violence incidents in Texas in 2025",
  "anti-Jewish hate crimes in Fort Worth, Texas in 2025 by location type",
  "change in robberies in Fort Worth, Texas from 2023 to 2025",
]) {
  const l = accountNibrsRequest(q);
  check(l.undischarged().length === 0 && l.residue().length === 0, `ledger covers every character: ${q}`);
  check(nibrsRecognitionRefusal(l) === null, `no recognition refusal: ${q}`);
}

// ---- paired readings: units are parts, never dropped or swapped ----
check(has("robbery offenders in Fort Worth, Texas in 2025", "unit", "offenders") && has("robbery offenders in Fort Worth, Texas in 2025", "measure", "robbery"), "\"robbery offenders\" keeps the offender unit");
check(has("robbery arrests in Fort Worth, Texas in 2025", "unit", "arrests"), "\"robbery arrests\" keeps the arrest unit");
check(!has("robberies in Fort Worth, Texas in 2025", "unit"), "a plain offense names no unit");
check(has("domestic violence arrests in Fort Worth, Texas in 2025", "measure", "domestic_violence") && has("domestic violence arrests in Fort Worth, Texas in 2025", "unit", "arrests"), "a family keeps its unit word");
check(has("female robbery offenders under 18 in Fort Worth, Texas in 2025", "filter", "sex:F") && has("female robbery offenders under 18 in Fort Worth, Texas in 2025", "filter", "age:Under 18"), "two filters are two parts");
check(has("robbery offenders in Fort Worth, Texas in 2025 by sex", "breakdown", "sex") && !has("robbery offenders in Fort Worth, Texas in 2025 by sex", "filter"), "\"by sex\" is a breakdown, not a filter");
check(has("offender age breakdown for robberies in Fort Worth", "breakdown", "age") && has("offender age breakdown for robberies in Fort Worth", "unit", "offenders"), "\"offender age breakdown\" is an age breakdown that keeps the offender unit");
check(has("robberies in Fort Worth, Texas by month in 2025", "grain", "month") && has("robberies in Fort Worth, Texas by month in 2025", "period", "year:2025"), "\"by month in 2025\" is a grain and a year");
check(has("robberies in Fort Worth, Texas in May 2025", "period", "month:2025-05") && !has("robberies in Fort Worth, Texas in May 2025", "place", "city:May:TX"), "\"May 2025\" is a month, never a place");
check(has("rolling 12-month robbery rate in Texas for January 2025", "rolling") && has("rolling 12-month robbery rate in Texas for January 2025", "period", "month:2025-01"), "rolling with a month");
check(has("rape clearance rate in Fort Worth, Texas in 2025", "clearance", "rate") && !has("rape clearance rate in Fort Worth, Texas in 2025", "statistic", "rate"), "\"clearance rate\" is a clearance part, not a per-capita rate");
check(has("what share of rapes in Fort Worth, Texas in 2025 were cleared because prosecution was declined?", "clearance-reason", "clearance:B") && !refused("what share of rapes in Fort Worth, Texas in 2025 were cleared because prosecution was declined?"), "\"prosecution was declined\" is a clearance reason, not a court word");
check(has("murder victims killed with a handgun in Fort Worth, Texas in 2025", "filter", "weapon:12") && !has("murder victims killed with a handgun in Fort Worth, Texas in 2025", "filter", "weapon:firearm"), "a handgun is a specific weapon, not the firearm category");
check(has("top 3 cities in Texas with over 100,000 people by murder clearance rate in 2025", "threshold", ">|100000") && has("top 3 cities in Texas with at least 100,000 people by murder clearance rate in 2025", "threshold", ">=|100000"), "\"over\" is strict, \"at least\" is not (L8)");
check(has("Tarrant County Sheriff's Office, Texas robberies in 2025", "place", "county:Tarrant:TX"), "a county sheriff's office is one county agency place");

// ---- recognition refusals: not recorded vs not interpreted ----
for (const [q, word, kind] of [
  ["crime by ZIP code in Chicago", "ZIP code", "not-recorded"],
  ["Can you provide the number of gun prosecutions per year over the last 20 years?", "prosecutions", "not-recorded"],
  ["carjackings in Fort Worth, Texas by day in 2025", "by day", "not-recorded"],
  ["fentanyl arrests in Texas in 2025", "fentanyl", "not-recorded"],
  ["robberies in Fort Worth, Texas by phase of the moon in 2025", "phase of the moon", "not-interpreted"],
  ["robberies for ORI TX0000FTW in 2025", "ORI", "not-interpreted"],
] as const) {
  const r = refused(q);
  check(Boolean(r && r.parts.some((p) => p.state === kind) && r.explanation.includes(word)), `${kind} names "${word}": ${q}`);
}

// ---- text vs numeric (decided from the turn as typed, r1.1 R1) ----
check(nibrsRequestKind(accountNibrsRequest("why do people commit robbery?")) === "text", "why with no numeric ask is text");
check(nibrsRequestKind(accountNibrsRequest("how many robberies were there in Fort Worth, Texas in 2025, and why?")) === "numeric", "an explicit numeric ask is answered even with why (L7)");
check(accountNibrsRequest("how many robberies were there in Fort Worth, Texas in 2025, and why?").parts.some((p) => p.concept === "explain" && p.clause === 1), "the why part is clause 1");
check(nibrsRequestKind(accountNibrsRequest("hello there")) === "text", "a greeting is text");

// ---- K2: filters keyed per dimension (r1.1 R1) ----
check(followupKey(accountNibrsRequest("female robbery offenders in Fort Worth, Texas in 2025").parts.find((p) => p.concept === "filter")!) === "filter:sex", "a sex filter is keyed by its dimension");
const prevAge = ["female robbery offenders in Fort Worth, Texas in 2025"];
check(nibrsFollowupCheck({ question: "only those under 18", effective: "female robbery offenders under 18 in Fort Worth, Texas in 2025", previousUserTurns: prevAge, isFollowUp }) === null, "K2: a new age filter keeps the inherited sex filter");
check(/female/.test(nibrsFollowupCheck({ question: "only those under 18", effective: "robbery offenders under 18 in Fort Worth, Texas in 2025", previousUserTurns: prevAge, isFollowUp })?.explanation ?? ""), "K2: an inherited filter of another dimension must survive");
check(nibrsFollowupCheck({ question: "Now what about just the share that's prosecution declined", effective: "Which share of rape clearances in Fort Worth, Texas in 2025 were cleared because prosecution was declined?", previousUserTurns: ["Which share of rape clearances in Fort Worth, Texas in 2025 were cleared by exception?"], isFollowUp }) === null, "K2: a clearance reason replaces the earlier clearance value (one dimension)");
check(/complete question/.test(nibrsFollowupCheck({ question: "and 2023?", effective: "robberies in Fort Worth, Texas in 2023", previousUserTurns: ["robberies in Fort Worth, Texas in 2025", "what about 2024?"], isFollowUp })?.explanation ?? ""), "K2: a follow-up of a follow-up is declined");
check(/complete question/.test(nibrsFollowupCheck({ question: "now do it for Plano, Texas", effective: null, previousUserTurns: ["robberies in Fort Worth, Texas in 2025"], isFollowUp })?.explanation ?? ""), "K2: no reconstruction is declined");

// ---- binding by value (L1-L3) ----
const L = (q: string) => accountNibrsRequest(q);
const now = new Date(Date.UTC(2026, 9, 9));
const ftw = placeIs.agency("Fort Worth", "TX");
const rob = { places: ftw, codeGroups: [["120"]], units: ["offenses"], statistic: "count" as const, years: { start: 2025, end: 2025 }, grains: ["year" as const] };
check(nibrsLegacyBound(L("How many robberies were reported in Fort Worth, Texas in 2025?"), rob, now), "a count path that applies every part owns the request");
check(!nibrsLegacyBound(L("robbery offenders in Fort Worth, Texas in 2025"), rob, now), "L1: an offense-count path does not own an offender question");
check(!nibrsLegacyBound(L("robberies in Fort Worth, Texas in 2024"), rob, now), "L3: the year is bound by value");
check(!nibrsLegacyBound(L("rolling 12-month robberies in Fort Worth, Texas for 2025"), rob, now), "a rolling window no path applies is never owned");
check(!nibrsLegacyBound(L("robberies in Fort Worth, Texas and in Texas in 2025"), rob, now), "a second place the path did not read is never owned");
check(nibrsUnboundParts(L("robberies in Fort Worth, Texas in 2025 by location type"), rob, now).some((p) => p.concept === "breakdown"), "the unbound part is reported");
check(!nibrsLegacyBound(L("hello"), {}, now) && !nibrsLegacyBound(L("thanks"), { places: ftw }, now), "no vacuous ownership");
const rank = { places: placeIs.state("Texas"), codeGroups: [["120"]], statistic: "rate" as const, rank: { dir: "top" as const, n: 2 }, years: { start: 2025, end: 2025 }, entities: ["city"] };
check(nibrsLegacyBound(L("top 2 cities in Texas by robbery rate in 2025"), rank, now), "a ranking binds its size and direction");
check(!nibrsLegacyBound(L("top 3 cities in Texas by robbery rate in 2025"), rank, now), "L3: a different rank size is not applied");
check(!nibrsLegacyBound(L("bottom 2 cities in Texas by robbery rate in 2025"), rank, now), "L3: a different direction is not applied");
check(nibrsLegacyBound(L("top 2 cities in Texas with at least 100,000 people by robbery rate in 2025"), { ...rank, thresholds: [{ op: ">=", amount: 100000 }] }, now)
  && !nibrsLegacyBound(L("top 2 cities in Texas with over 100,000 people by robbery rate in 2025"), { ...rank, thresholds: [{ op: ">=", amount: 100000 }] }, now), "a threshold binds its operator and amount");
check(!nibrsLegacyBound(L("why did robberies in Fort Worth, Texas fall in 2025?"), { ...rob, change: ["decrease"] }, now)
  && nibrsLegacyBound(L("why did robberies in Fort Worth, Texas fall in 2025?"), { ...rob, change: ["decrease"], explain: true }, now), "L2: only a path that applies 'why' owns it");
check(JSON.stringify(expandCodes(["23A-23H"])) === JSON.stringify(["23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H"]), "the contract's theft range expands");
check(JSON.stringify(periodRange("range:2025:2021", now)) === JSON.stringify({ start: 2021, end: 2025 }) && periodRange("years:2021:2025", now) === null, "periods read as year ranges; two separate years are not a range");

// ---- r2.2: a by-year demographic answer names requested years with no rows ----
const demoQ = { guardrail: "deterministic-nibrs-local-demographic-count", title: "t", applied: { years: { start: 2023, end: 2025 }, grains: ["year" as const] } };
check(/no rows for 2023 or 2024/.test(demographicMissingYearsNote(demoQ, [{ year: 2025, offenders: 4 }]) ?? ""), "r2.2: missing requested years are named");
check(demographicMissingYearsNote(demoQ, [{ year: 2023 }, { year: 2024 }, { year: 2025 }]) === null, "r2.2: no note when every requested year has rows");
check(demographicMissingYearsNote({ ...demoQ, guardrail: "deterministic-nibrs-local-count" }, [{ year: 2025 }]) === null, "r2.2: only the local demographic family");
check(/either/.test(demographicMissingYearsNote(demoQ, [{ year: 2025 }]) ?? "") && !/because/i.test(demographicMissingYearsNote(demoQ, [{ year: 2025 }]) ?? ""), "r2.2: the note gives both possible reasons, not one");
check(has("robbery victims in Texas in 2025 by offender age", "breakdown", "offender-age"), "r2: by offender age keeps whose age");

// Round 1 W21: a period-only follow-up replaces the earlier question's single period (year, range or since); anything else is left alone.
{
  const r = (q: string, prev: string) => resolveNibrsPeriodReplacement(q, [prev])?.refinedQuestion ?? null;
  check(r("show it from 2020 to 2024", "Memphis carjackings per month") === "Memphis carjackings per month from 2020 to 2024", "W21 range after a question with no period");
  check(r("do it for 2023", "Memphis carjackings per month in 2025") === "Memphis carjackings per month in 2023", "single year still replaced");
  check(r("show that from 2018 to 2020", "Memphis carjackings per year from 2021 to 2025") === "Memphis carjackings per year from 2018 to 2020", "a range replaces a range");
  check(r("show it since 2019", "Memphis carjackings per month") === "Memphis carjackings per month since 2019", "since");
  check(r("show it from 2020 to 2024", "Memphis carjackings in 2019 and 2021") === null, "an earlier question with other year wording is left alone");
  check(r("show robberies from 2020 to 2024", "Memphis carjackings per month") === null, "a new measure is not a period-only follow-up");
  check(nibrsFollowupCheck({ question: "show it from 2020 to 2024", effective: "Memphis carjackings per month from 2020 to 2024", previousUserTurns: ["Memphis carjackings per month"], isFollowUp }) === null, "K2 accepts the rebuilt question (place, measure, grain carried)");
}
console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
