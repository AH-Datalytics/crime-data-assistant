/*
 * Request accounting, stage 3a (Current Trends; plan docs/superpowers/plans/2026-10-10-request-accounting-stage3a-current.md
 * r1.2): the ledger, the closed list of question types, the binding and its owner policy, the follow-up check and the
 * one effective-request resolution. No database, no route.
 */
import "./offline-evidence-guard";
import assert from "node:assert/strict";
import { accountCurrentRequest, currentRequestKind, currentFollowupCheck, CURRENT_CACHE_TAB } from "../lib/current-request-accounting";
import { matchCurrentType } from "../lib/current-question-types";
import { currentLegacyBound, currentPolicyAllows, periodValuesOfMonths, placeIs } from "../lib/current-legacy-binding";
import { resolveFollowupRequest } from "../lib/current-effective-request";
import { resolveCurrentFollowupAmendment } from "../lib/current-followup-amendment";
import { FBI_CITY_GROUPS } from "../lib/current-question-compiler";
import { isFollowUp } from "../lib/tab-suggest";

let checks = 0;
const check = (ok: boolean, label: string) => { checks += 1; assert.ok(ok, label); if (!process.env.QUIET) console.log(`  PASS  ${label}`); };
const parts = (q: string) => accountCurrentRequest(q).parts.filter((p) => p.state !== "context").map((p) => `${p.concept}${p.state === "recognized" ? "" : `!${p.state}`}=${p.value ?? p.text}`);
const has = (q: string, part: string) => parts(q).includes(part);
const decision = (q: string) => matchCurrentType(accountCurrentRequest(q));
const declines = (q: string, re: RegExp) => { const d = decision(q); return d.kind === "decline" && re.test(d.explanation); };

// ---- the ledger
check(has("robberies in Seattle, WA in May 2026", "period=month:2026-05") && has("robberies in Seattle, WA in May 2026", "place=city:Seattle:WA"), "a month and year is a month period, and the place is the city");
check(has("robberies in Seattle, WA January to May 2025 vs January to May 2026", "period=monthrange:2025-01:2025-05"), "a month span inside one year is a month range");
// Codex build review (W22): "make that monthly" after a RATE question must carry the rate; a rebuilt question that drops it refuses.
{
  const isFollowUp = (q: string) => /^\s*(?:make\s+(?:it|that|this)|now|and)\b/i.test(q);
  const prev = ["Murder rates in Chicago, IL in 2025"];
  check(currentFollowupCheck({ question: "make that monthly", effective: "Murders in Chicago, IL in 2025 by month", previousUserTurns: prev, isFollowUp }) !== null, "W22: a rebuilt question that drops the earlier rate refuses");
  check(currentFollowupCheck({ question: "make that monthly", effective: "Murder rates in Chicago, IL in 2025 by month", previousUserTurns: prev, isFollowUp }) === null, "W22: the rebuilt question carrying the rate passes");
}
// Round 1 Q9: two named months of one year.
check(has("National murders in July and August 2026", "period=monthrange:2026-07:2026-08"), "Q9 July and August 2026 = exactly July-August");
check(!parts("National murders in July and August 2026").some((p) => p.includes("!not-interpreted")), "Q9 nothing left over in 'July and August 2026'");
check(has("murders in Chicago, IL in Jan and Feb 2026", "period=monthrange:2026-01:2026-02"), "Q9 abbreviated consecutive months");
check(declines("National murders in January and March 2026", /couldn't read that as a period/), "Q9 non-consecutive months are declined, never widened into a range");
check(has("murders in Chicago, IL in May 2026", "period=month:2026-05"), "Q9 control: a single month is unchanged");
check(has("rolling 12-month robberies in Seattle, WA for 2025", "rolling=rolling12"), "rolling 12-month is its own part");
check(has("compare robberies in Fresno, CA to similar-sized cities in 2025", "peer=peer::city") && has("compare robberies in Austin, TX to 3 similar-sized cities in 2025", "peer=peer:3:city"), "similar-sized cities is a peer part, with its number");
check(has("compare robberies in Harris County, TX to similar-sized counties in 2025", "peer=peer::county"), "similar-sized counties is a county peer part");
check(has("What is the most common crime in Denver, CO in 2025?", "sort=most-common"), "most common crime is a sort part, not a ranking");
check(has("Give me an overview of crime in Denver, CO in 2025", "overview=all7"), "an overview names all seven offenses");
check(has("juvenile robberies in Seattle, WA in 2025", "people!not-recorded=juvenile"), "juveniles are not tracked");
check(has("cybercrime in Seattle, WA in 2025", "other-offense!not-recorded=cybercrime") && has("carjackings in Seattle, WA in 2025", "other-offense!not-recorded=carjackings"), "offenses outside the seven are not tracked");
check(has("robbery clearance rate in Seattle, WA in 2025", "clearance!not-recorded=clearance rate"), "clearance is not tracked on Current (Historical has it)");
check(has("robberies with a banana in Seattle, WA in 2025", "unrecognized!not-interpreted=with a banana in"), "an unknown phrase is residue, named in the reader's words");
check(!parts("What can you tell me about how Current Trends data is collected?").some((p) => p.startsWith("grain")), "the tab's own name is not a trends grain");
check(has("Rank cities with at least 10 murders by rate of murder in 2025", "count-threshold=>=|10") && has("Which 2 cities had the most murders in 2024?", "rank=top:2"), "a ranking's count condition and its number of places are parts");
check(has("Rank cities by murder totals in 2025", "statistic=count") && has("how many agencies are covered?", "coverage-lookup=coverage"), "\"totals\" is a count; \"covered\" asks about coverage");
check(currentLegacyBound(accountCurrentRequest("Rank cities with at least 10 murders by rate of murder in 2025"), { places: placeIs.national, measures: ["murder"], statistic: "rate", rank: { dir: "top", n: 20 }, periodValues: ["year:2025"], countThresholds: [{ op: ">=", amount: 10 }], entities: ["city"] })
  && !currentLegacyBound(accountCurrentRequest("Rank cities with at least 10 murders by rate of murder in 2025"), { places: placeIs.national, measures: ["murder"], statistic: "rate", rank: { dir: "top", n: 20 }, periodValues: ["year:2025"], entities: ["city"] }), "a ranking binds its count condition by value");
check(currentRequestKind(accountCurrentRequest("Why are there no trend lines in the chart?")) === "text", "a why with no numeric ask is TEXT");
check(currentRequestKind(accountCurrentRequest("robberies in Seattle, WA in 2025")) === "numeric", "a count request is NUMERIC");
check(CURRENT_CACHE_TAB === "current:request-accounting-3a", "the Current cache namespace changed with this stage");

// ---- the types and their named declines
const spec = (q: string) => { const d = decision(q); return d.kind === "spec" ? d.spec : null; };
check(spec("robberies in Seattle, WA in 2025")?.type === "series", "C1 builds a series");
const c2 = spec("compare robberies in Seattle, WA and Denver, CO from 2024 to 2025");
check(c2?.type === "series" && c2.places.length === 2 && c2.grain === "month", "C2: named places side by side, monthly for a range with no grain word");
const c3 = spec("What is the most common crime in Denver, CO?");
check(c3?.type === "series" && c3.sort && c3.measures.length === 7 && c3.period.form === "latest", "C3 sorted with no period uses the latest full year");
check(spec("How much did robberies change in Seattle, WA from 2024 to 2025?")?.type === "change", "C5: a change between two years");
const c6 = spec("Compare the robbery rate for San Francisco, CA against 3 cities of similar size in 2025");
check(c6?.type === "peers" && c6.n === 3 && c6.statistic === "rate", "C6: peers with their number and a rate");
check(declines("national robbery rate in 2025", /national or state rate/) && declines("robbery rate in Texas in 2025", /Historical/), "ruling 3: national and state rates are declined with the Historical pointer");
check(declines("which states had the highest robbery rate in 2025?", /doesn't rank states/), "state rankings are declined with the Historical pointer");
check(declines("compare robberies in Seattle, WA, Denver, CO, Boston, MA, Detroit, MI, Portland, OR, Memphis, TN, Baltimore, MD, Milwaukee, WI, Tucson, AZ, Fresno, CA and Oakland, CA in 2025", /ten places/), "eleven places are declined");
check(declines("compare robberies in Harris County, TX to similar-sized counties in 2025", /metropolitan/), "a county has no size group (ruling 5)");
check(declines("compare robberies in San Francisco, CA to 12 similar-sized cities in 2025", /up to 9/), "more than nine peers is declined");
check(declines("the robbery count and the burglary rate in Denver, CO in 2025", /one statistic/), "one statistic per answer");
check(declines("total robbery rate in Seattle, WA from 2024 to 2025 combined", /one rate per year/), "no pooled multi-year rate (r1.1 F4)");
check(declines("robberies per 10,000 residents in Seattle, WA in 2025", /per 10,000/), "another rate scale is declined by name");
check(declines("Is there evidence for why an increase in 2025", /can't explain why/), "a why beside an unbuildable number says causes aren't explained");

// ---- binding and policy
const ledger = accountCurrentRequest("robberies in Seattle, WA in 2025");
const seattle = placeIs.agency("Seattle", "WA");
check(currentLegacyBound(ledger, { places: seattle, measures: ["robbery"], periodValues: ["year:2025"], statistic: "count" }), "a path applying every part by value is bound");
check(!currentLegacyBound(ledger, { places: seattle, measures: ["burglary"], periodValues: ["year:2025"] }), "a different measure is not bound");
check(!currentLegacyBound(ledger, { places: seattle, measures: ["robbery"], periodValues: ["year:2024"] }), "a different year is not bound");
check(!currentPolicyAllows({ statistic: "rate", places: placeIs.national }) && !currentPolicyAllows({ statistic: "rate", places: placeIs.state("Texas") }), "policy: no national or state rate");
check(currentPolicyAllows({ statistic: "rate", places: placeIs.state("Texas"), rank: { dir: "top", n: 20 } }), "policy: a ranking of cities within a state may rank by rate");
check(currentPolicyAllows({ statistic: "rate", places: seattle }), "policy: an agency rate is allowed");
const cut = { year: 2026, month: 5 };
const span = (a: [number, number], b: [number, number]) => { const out: [number, number][] = []; let [y, m] = a; while (y * 100 + m <= b[0] * 100 + b[1]) { out.push([y, m]); m += 1; if (m > 12) { m = 1; y += 1; } } return out; };
check(periodValuesOfMonths(span([2025, 1], [2025, 12]), cut).includes("year:2025"), "twelve months of a year are that year");
check(periodValuesOfMonths(span([2026, 1], [2026, 5]), cut).includes("year:2026") && periodValuesOfMonths(span([2026, 1], [2026, 5]), cut).includes("ytd"), "January to the cutoff is the cutoff year, as far as it goes");
check(!periodValuesOfMonths(span([2025, 1], [2025, 11]), cut).includes("year:2025"), "eleven months are not the year");
check(periodValuesOfMonths(span([2024, 1], [2025, 12]), cut).includes("range:2024:2025"), "two whole years are the range");

// ---- K2 and the effective request (r1.1 F5)
const turns = (...qs: string[]) => qs.flatMap((q) => [{ role: "user", content: q }, { role: "assistant", content: `Here is ${q}.` }]);
check(Boolean(currentFollowupCheck({ question: "same for Denver", effective: "robberies in Denver, CO in 2025", previousUserTurns: ["robbery rate in Seattle, WA in 2025"], isFollowUp })), "K2: a reconstruction that drops the earlier rate is declined");
check(currentFollowupCheck({ question: "same for Denver", effective: "robberies in Denver, CO in 2025", previousUserTurns: ["robberies in Seattle, WA in 2025"], isFollowUp }) === null, "K2: a reconstruction carrying every earlier part passes");
check(/earlier follow-up/.test(currentFollowupCheck({ question: "and 2024", effective: "robberies in Denver, CO in 2024", previousUserTurns: ["robberies in Seattle, WA in 2025", "what about Denver"], isFollowUp })?.explanation ?? ""), "K2: a follow-up of a follow-up is declined");
const hist = turns("rolling 12-month robberies in Seattle, WA for 2025");
const amendment = resolveCurrentFollowupAmendment("now Denver, CO", hist, "current");
const viaAmendment = resolveFollowupRequest({ question: "now Denver, CO", rawHistory: hist, source: "current", authoritative: null, amendment });
check(viaAmendment.resolver === "amendment" && /Denver/.test(viaAmendment.question) && /rolling/.test(viaAmendment.question), "the effective request of an amendment is its composed rendering");
const viaPlanner = resolveFollowupRequest({ question: "now Denver, CO", rawHistory: hist, source: "current", authoritative: { reconstructedQuestion: "robberies in Denver, CO in 2025", transform: null }, amendment });
check(viaPlanner.resolver === "planner" && viaPlanner.question === "robberies in Denver, CO in 2025", "the authoritative planner comes first, as before");

// ---- FBI population groups (task0/coverage-and-population.md)
const groupOf = (n: number) => FBI_CITY_GROUPS.find((g) => n >= g.lo && n <= g.hi)!.label;
check(groupOf(500000) === "500,000 to 999,999" && groupOf(999999) === "500,000 to 999,999" && groupOf(815330) === "500,000 to 999,999", "500,000 and 999,999 are both in the 500,000-999,999 group (Jeff's band)");
check(groupOf(499999) === "250,000 to 499,999" && groupOf(1000000) === "1,000,000 and over", "the neighbouring groups start and end where the FBI's do");

console.log(`\n${checks}/${checks} passed`);
