/**
 * The shadow reader's pre-pass (lib/nibrs-shadow/reading.ts) reads general wording forms the accounting does not, and
 * nothing else: one near crime or state word corrects a misspelling (two near, or none, do not); crime-phrase variants
 * map onto existing measures only; "year to date" forms become the current year; future questions and court outcomes are
 * flagged. Boundaries keep their own meaning. The wordings here are not the held-out cases' (LS-246..LS-270). Offline.
 */
import assert from "node:assert/strict";
import { nearestWord, readQuestion } from "../lib/nibrs-shadow/reading";

const read = (q: string) => readQuestion(q, 2026);

// Misspellings: one dropped, added or swapped letter from exactly one crime or state word, 7 letters or more. A changed
// letter is never corrected, so real words stay what they are (Codex review 2: "Sample assaults" is not simple assault).
assert.equal(nearestWord("Shoplfting"), "shoplifting");
assert.equal(nearestWord("robbeyr"), "robbery", "a swapped pair");
assert.equal(nearestWord("Tennesee"), "tennessee");
assert.equal(nearestWord("viriginia"), "virginia", "an added letter");
for (const w of ["sample", "violet", "robery", "arsen", "shooting", "shopping", "Shplftg", "parking", "shoplofting"]) assert.equal(nearestWord(w), null, w);
const sp = read("burglries in Pittsburgh in 2023");
assert.deepEqual(sp.readings, [{ kind: "spelling", from: "burglries", to: "burglaries" }]);
assert.equal(read("Robberies in Pittsburgh in 2023").readings.length, 0, "nothing to correct, nothing recorded");

// Crime phrases: onto existing measures; motor vehicle theft keeps its own meaning.
assert.equal(read("thefts from trucks in Tulsa in 2022").text, "theft from motor vehicle in Tulsa in 2022");
assert.equal(read("auto break-ins in Tulsa in 2022").text, "car break-ins in Tulsa in 2022");
assert.equal(read("car jackings in Tulsa in 2022").text, "carjackings in Tulsa in 2022");
assert.equal(read("motor vehicle thefts in Tulsa in 2022").readings.length, 0);
assert.equal(read("car thefts in Tulsa in 2022").readings.length, 0, "car theft is motor vehicle theft, not theft from a car");

// A breakdown asked as its categories, or with "and" before a time grain (compiler increment 1).
assert.equal(read("How many robbery victims in Tulsa were women or men in 2022?").text, "How many robbery victims in Tulsa by sex in 2022?");
assert.equal(read("arsons in Tulsa by location type and month, 2022").text, "arsons in Tulsa by location type by month, 2022");
assert.equal(read("robberies in Tulsa by weapon and year").text, "robberies in Tulsa by weapon by year", "every breakdown asked is read: weapon by year (coordinator 2026-11-02), never the year dropped");
assert.equal(read("robbery offenders in Tulsa by year and age").text, "robbery offenders in Tulsa by age by year");
assert.equal(read("Simple assaults committed by men and women in Tulsa in 2023").readings.length, 0, "offenders, not victims: left alone");
// P29 (Jeff): "by" names the offenders, "against" names the victims.
assert.equal(read("robberies against men and women in Tulsa in 2022").text, "robberies by sex in Tulsa in 2022");
for (const q of ["assaults by men and women in Tulsa", "robberies by women in Tulsa"]) assert.equal(read(q).offenders, true, q);
// Increment 7: "by juveniles" is read (an offender under 18 in the incident, P49), so it is no longer unsupported.
assert.deepEqual([read("burglaries committed by juveniles in Tulsa").offenders, read("burglaries committed by juveniles in Tulsa").people?.where], [false, [{ who: "offender", attr: "age", range: [1, 17], paired: false }]]);
// Codex increment-7 review 04.2: a victim's attribute on arrests is never read as the arrestee's.
assert.deepEqual([read("Arrests in Denver in 2023 by victim race").people?.unsupported, read("Arrests in Denver in 2023 by victim race").people?.by], ["a victim's race for arrests", null]);
assert.equal(read("Aggravated assault victims in Tulsa in 2024, by victim race").text, "Aggravated assault victims in Tulsa in 2024 by race");
// Codex 05: the rewritten words are what the accounting reads ("by race" a breakdown, nothing left unread).
{ const l = read("Aggravated assault victims in Tulsa in 2024, by victim race").ledger.parts.filter((p) => p.clause === 0);
  assert.ok(l.some((p) => p.concept === "breakdown" && p.value === "race") && !l.some((p) => p.state === "not-interpreted"), JSON.stringify(l.map((p) => [p.concept, p.value, p.state]))); }
for (const q of ["robberies by sex in Tulsa", "assaults against women in Tulsa", "robberies by month in Tulsa"]) assert.equal(read(q).offenders, false, q);
assert.equal(read("Were male or female victims assaulted more in Tulsa?").readings.length, 0, "no 'victims ... were' form");

// Year to date: the current year (the release clips it and names the months, D06); "last year" is left alone.
assert.equal(read("robberies in Tulsa year to date").text, "robberies in Tulsa in 2026");
assert.equal(read("ytd burglaries in Tulsa").text, "in 2026 burglaries in Tulsa");
assert.equal(read("arsons in Tulsa so far in 2026").text, "arsons in Tulsa in 2026");
assert.equal(read("robberies in Tulsa last year").readings.length, 0);

// Forecasts (P20): the future, not merely a year the data does not hold yet (P24).
for (const q of ["Will robberies rise in Tulsa?", "What will arsons be in Tulsa in 2031?", "forecast burglaries in Tulsa", "Are robberies going to increase in Tulsa?",
  "Predicting burglaries in Tulsa in 2028", "Will burglaries in Tulsa go up next year?", "burglaries in Tulsa are expected to rise"])
  assert.equal(read(q).forecast, true, q);
for (const q of ["How many arrests will the 2023 numbers show in Tulsa?", "Robberies in Tulsa in 2027", "Robberies in Tulsa this year", "robberies in Tulsa next year"])
  assert.equal(read(q).forecast, false, q);
// A future year with nothing predicting is a period after the data (P24), not a forecast.
assert.equal(read("robberies in Tulsa next year").text, "robberies in Tulsa in 2027");

// Court outcomes (D01) the accounting does not name.
for (const q of ["How many robbery arrests in Tulsa went to trial in 2023?", "robbers sentenced in Tulsa in 2023", "guilty pleas for burglary in Tulsa"]) assert.equal(read(q).court, true, q);
for (const q of ["robbery arrests in Tulsa in 2023", "robberies cleared in Tulsa in 2023"]) assert.equal(read(q).court, false, q);

// Charging decisions are declined like court outcomes (P46).
for (const q of ["How many robbery suspects were charged in Tulsa in 2024?", "robberies in Tulsa with charges filed"]) assert.equal(read(q).court, true, q);

// P48: people arrested for a crime are its arrests.
assert.equal(read("How many people were arrested for burglary in Tulsa in 2024?").text, "How many burglary arrests in Tulsa in 2024?");
assert.equal(read("people arrested for shoplifting in Tulsa").text, "shoplifting arrests in Tulsa");
// P31: composites read as their crimes, with the weapon flagged; gun violence and shooters are undefined terms (P45).
const gc = read("Gun crime in Tulsa in 2023");
assert.deepEqual([gc.text, gc.composite], ["murders, robberies and aggravated assaults in Tulsa in 2023", "firearm"]);
assert.deepEqual([read("Stabbings in Tulsa in 2023").text, read("Stabbings in Tulsa in 2023").composite], ["murders and aggravated assaults in Tulsa in 2023", "knife"]);
assert.equal(read("Robberies in Tulsa in 2023").composite, null);
assert.deepEqual([read("Gun violence in Tulsa in 2023").undefinedTerm, read("How many shooters were there in Tulsa?").undefinedTerm, read("Gun crime in Tulsa").undefinedTerm], ["gun violence", "shooters", null]);

// Increment 3: comparisons are recorded with their periods, and the question passed on as a count over the span.
const cmp = (q: string) => readQuestion(q, 2026, "2026-09");
assert.deepEqual([cmp("Shoplifting in Tulsa in 2024 compared with 2023").text, cmp("Shoplifting in Tulsa in 2024 compared with 2023").comparison],
  ["Shoplifting in Tulsa from 2023 to 2024", { earlier: { from: "2023-01", to: "2023-12" }, later: { from: "2024-01", to: "2024-12" }, matched: false }]);
assert.equal(cmp("Percent change in robberies with a firearm in Tulsa from 2021 to 2025").text, "Robberies with a firearm in Tulsa from 2021 to 2025");
assert.deepEqual(cmp("Did burglaries go up in Tulsa in 2025?").comparison?.earlier, { from: "2024-01", to: "2024-12" }, "P54: the year before");
assert.deepEqual(cmp("Did burglaries go up in Tulsa in 2025?").forecast, false, "a past year is not a forecast");
assert.deepEqual(cmp("Is shoplifting in Tulsa up this year compared with last year?").comparison, { earlier: { from: "2025-01", to: "2025-12" }, later: { from: "2026-01", to: "2026-12" }, matched: true });
assert.deepEqual(cmp("Shoplifting in Tulsa January through June 2024 compared with January through June 2023").comparison,
  { earlier: { from: "2023-01", to: "2023-06" }, later: { from: "2024-01", to: "2024-06" }, matched: true });
assert.equal(cmp("Shoplifting in Tulsa January through June 2024 compared with March through May 2023").comparison, null, "different months: not read as a comparison");
assert.equal(cmp("Will shoplifting go up in Tulsa next year?").forecast, true, "a forecast stays a forecast");
// P56: the last 12 months end at the release's latest month.
assert.deepEqual([cmp("Shoplifting in Tulsa over the last 12 months").text, cmp("Shoplifting in Tulsa over the last 12 months").last12], ["Shoplifting in Tulsa from October 2025 to September 2026", true]);
assert.equal(readQuestion("Shoplifting in Tulsa over the last 12 months", 2026).last12, false, "without a release month the wording is left to the reader");
// Census regions (Current Trends' groups, coordinator 2026-11-03): read as the nation and flagged; never a state or a
// part of a city.
for (const [q, code] of [["robberies in the Northeast by month in 2026", "noe"], ["murders in the South so far this year", "sth"], ["show me robberies per month in the northeast US", "noe"],
  ["midwest murders by year from 2018 to 2020", "mdw"], ["murders in the West in 2026", "wst"], ["murders in South Carolina in 2023", null], ["robberies on the South Side of Chicago in 2023", null],
  ["West Memphis murders in 2023", null], ["murders in the West End in 2023", null],
  // Codex review 01.5: real places named like a region.
  ["Midwest City murders in 2024", null], ["Murders in North East, Maryland in 2024", null]] as [string, string | null][])
  assert.equal(readQuestion(q, 2026).region, code, q);
// "NY" for a place is New York (P26 asks city or state); after a place it qualifies, it stays; "NY city" is the city.
assert.match(readQuestion("NY murders in 2023", 2026).text, /^New York murders/);
assert.match(readQuestion("homicides in ny city in 2023", 2026).text, /in New York City in 2023/);
assert.match(readQuestion("Rochester NY murders in 2023", 2026).text, /^Rochester NY murders/);
assert.match(readQuestion("homicides reported by the Suffern (NY) Police Department", 2026).text, /\(NY\)/);
// Circumstances (element 31, coordinator 2026-11-04): a filter, taken out of the words; domestic violence is not one.
assert.deepEqual(readQuestion("Gang-related murders in Chicago by year since 2020", 2026).circumstance, ["04", "05"]);
assert.match(readQuestion("Gang-related murders in Chicago by year since 2020", 2026).text, /^murders in Chicago/);
assert.deepEqual(readQuestion("Aggravated assault victims in Memphis from arguments in 2024", 2026).circumstance, ["01"]);
assert.equal(readQuestion("Domestic violence murders in Texas in 2024", 2026).circumstance, null);
assert.equal(readQuestion("Drug-related arrests in Memphis in 2024", 2026).circumstance, null, "drug crimes, not a circumstance");
// Places' nicknames, read for every source (coordinator 2026-11-02).
assert.match(readQuestion("Philly homicides 2010 to 2020", 2026).text, /^Philadelphia homicides/);
assert.match(readQuestion("murders in NOLA since 2015", 2026).text, /in New Orleans since/);
assert.equal(readQuestion("Nolan County robberies in 2020", 2026).text.includes("New Orleans"), false, "a whole word only");

// Every rewrite is recorded on the ledger the reader reads.
const l = read("Shoplfting in Tulsa so far this year").ledger;
assert.deepEqual(l.readings.map((r) => r.kind), ["period", "spelling"]);
assert.equal(l.question, "Shoplifting in Tulsa in 2026");

console.log("nibrs shadow reading: general wording forms read; boundaries keep their meaning");
