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
for (const w of ["sample", "violet", "arsen", "shooting", "shopping", "Shplftg", "parking", "shoplofting", "sates", "cites", "rather", "showing", "status", "months", "single", "proper", "present", "murdered", "grapes", "cries", "amine"]) assert.equal(nearestWord(w), null, w);
// Five- and six-letter typos that aren't English (coordinator 2026-11-05, the query log's misspelling cluster).
for (const [w, to] of [["cirme", "crime"], ["cirmes", "crimes"], ["citites", "cities"], ["couunty", "county"], ["offfender", "offender"]])
  assert.equal(nearestWord(w), to, w);
// Changed-letter misspellings seen in the log are read by name.
assert.ok(/aggravated assault rates/.test(read("what are the top 10 cities aggrevated assault rates").text));
assert.ok(/violent crime rate/.test(read("can I see the vlolent crime rate per 100,000 in salem oregon since 1950").text));
assert.ok(/clearance rate/.test(read("What is the ckearance rate for homicides in Philadelphia for 2023?").text));
assert.ok(/\bmurders 1960/.test(read("Dc muders 1960").text) && /\brobbery in/.test(read("robery in Memphis in 2024").text), "dropped-letter typos the log has, by name");
assert.ok(/aggravates/.test(read("What aggravates assault in Philadelphia in 2024?").text), "a verb, not a misspelling (Codex spelling review 01)");
assert.ok(/aggrevates/.test(read("What aggrevates assault in Philadelphia in 2024?").text), "the verb misspelled (Codex spelling review 04)");
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
assert.deepEqual(readQuestion("Murders during an argument in Chicago by year since 2020", 2026).circumstance, ["01"]);
assert.doesNotMatch(readQuestion("Murders during an argument in Chicago by year since 2020", 2026).text, /argument/);
// Gang wording is not a circumstance: it is declined by policy (P38, Jeff 2026-11-09).
for (const q of ["Gang-related murders in Chicago by year since 2020", "gangland killings in 2024", "gangrelated murders in Memphis", "gangs in Houston"]) {
  assert.equal(readQuestion(q, 2026).circumstance, null, q);
  assert.equal(readQuestion(q, 2026).undefinedTerm, "gang", q);
}
assert.equal(readQuestion("murders in Gangnam in 2024", 2026).undefinedTerm, null);
assert.deepEqual(readQuestion("Aggravated assault victims in Memphis from arguments in 2024", 2026).circumstance, ["01"]);
assert.equal(readQuestion("Domestic violence murders in Texas in 2024", 2026).circumstance, null);
assert.equal(readQuestion("Arrests in arguments in Memphis in 2024", 2026).circumstance, null);
assert.equal(readQuestion("Assaults during an argumentative dispute in Memphis in 2024", 2026).circumstance, null);
assert.equal(readQuestion("Drug-related arrests in Memphis in 2024", 2026).circumstance, null, "drug crimes, not a circumstance");
// Places' nicknames, read for every source (coordinator 2026-11-02).
assert.match(readQuestion("Philly homicides 2010 to 2020", 2026).text, /^Philadelphia homicides/);
assert.match(readQuestion("murders in NOLA since 2015", 2026).text, /in New Orleans since/);
assert.equal(readQuestion("Nolan County robberies in 2020", 2026).text.includes("New Orleans"), false, "a whole word only");

// Every rewrite is recorded on the ledger the reader reads.
const l = read("Shoplfting in Tulsa so far this year").ledger;
assert.deepEqual(l.readings.map((r) => r.kind), ["period", "spelling"]);
assert.equal(l.question, "Shoplifting in Tulsa in 2026");

// Comparison and change wording (Jeff 2026-11-11: "a lack of understanding of the word 'how'"): read in full, never a
// word of place, crime or time dropped.
const unreadOf = (q: string) => readQuestion(q, 2026, "2026-09").ledger.parts.filter((p) => p.state === "not-interpreted").map((p) => p.text.trim());
assert.equal(readQuestion("Show me how rape offenses have changed in Texas over the past 10 years", 2026).text, "rape offenses by year in Texas over the past 10 years");
assert.equal(readQuestion("How have robberies in Nashville changed since 2020?", 2026).text, "robberies in Nashville by year since 2020?");
assert.equal(readQuestion("How does Chicago murder count compare to Illinois statewide?", 2026).text, "Chicago murder count and Illinois?");
assert.equal(readQuestion("Compare Houston's murder rate to the Texas state average", 2026).text, "Houston's murder rate and Texas");
assert.match(readQuestion("Baltimore violent crime rate compared to the national rate since 2015", 2026).text, /and the United States since 2015/);
// The national rate as the only rate word is left as written (Codex comparison review 01.1).
assert.match(readQuestion("How does murder in Texas compare to the national rate in 2023?", 2026).text, /national rate/);
assert.match(readQuestion("Compare murder rate in Texas to the national total in 2023", 2026).text, /national total/, "a total against a rate is left as written");
const lastYear = readQuestion("How has violent crime changed in the last year in Washington D.C.?", 2026);
assert.deepEqual(lastYear.comparison, { earlier: { from: "2024-01", to: "2024-12" }, later: { from: "2025-01", to: "2025-12" }, matched: false });
const early = readQuestion("Homicide rates in Kansas City MO in 2022 vs 2025", 2026);
assert.deepEqual([early.comparison?.earlier.from, early.comparison?.later.to], ["2022-01", "2025-12"], "the earlier year first");
for (const q of ["homicide in philadelphia by months since 2015", "Houston carjackings per months since 2019", "homicides in Memphis, TN 2026 year-to-date",
  "Show me the homicide rate in Macon Georgia over 5 years", "Show me the number of murders in Nashville going back to 1935", "fatal shootings in Chicago by year since 2020"])
  assert.deepEqual(unreadOf(q), [], q);
assert.match(readQuestion("fatal shootings in Houston since 2015", 2026).text, /^firearm murders in Houston/);
// Jeff's example: only the pure filler "me the" is left, so the rest is answered as asked.
assert.deepEqual(unreadOf("plot me the number of assaults in Glassboro NJ from 2010 to 2024"), ["me the"]);

// Arrests (2026-11-11): every arrest with no crime named, an age range on the counted person, "cases", Group B names.
const rq = (q: string) => readQuestion(q, 2026, "2026-09");
assert.equal(rq("How many arrests were made in 2024 in the United States?").text, "All crime arrests in 2024 in the United States?");
assert.equal(rq("arrests for robbery in Texas in 2024").text, "arrests for robbery in Texas in 2024", "a crime named is never every arrest");
assert.equal(rq("how many arrests in 2024 for robbery in Texas").text.startsWith("All crime"), false);
assert.equal(rq("How many arrests for peeping tom in Ohio in 2024").text.startsWith("All crime"), false, "a Group B crime named (Codex arrests 01.1)");
for (const q of ["arrests in Ohio in 2024 for robbery", "arrests for Robbery in Ohio in 2024"]) assert.equal(rq(q).text.startsWith("All crime"), false, q);
for (const q of ["arrests of people under age 18 by year in Minneapolis, MN, from 2020 through 2025", "nationwide arrests by age by year for 2017 to 2025", "show me nationwide juvenile arrests 2017 to 2025"])
  assert.equal(rq(q).text.includes("All crime arrests"), true, q);
for (const q of ["how many arrests nationally in 2024 by sex", "how many arrests in Guntersville, Alabama in 2024"])
  assert.equal(rq(q).text.startsWith("All crime arrests"), true, q);
const ages = rq("show me all arrestees ages 18 to 21 in vermont by year");
assert.equal(ages.text, "All crime arrests in vermont by year");
assert.deepEqual(ages.people?.where, [{ who: "arrestee", attr: "age", range: [18, 21], paired: false }]);
assert.deepEqual(rq("murder victims aged 18 to 24 in Memphis in 2024").people?.where, [{ who: "victim", attr: "age", range: [18, 24], paired: false }]);
assert.equal(rq("arrests of people under 18 in Minneapolis in 2024").text, "All crime arrests under 18 in Minneapolis in 2024");
assert.equal(rq("nationwide arrests by age by year for 2017 to 2025").text, "All crime arrests nationally by age by year for 2017 to 2025", "the place word kept (AR1)");
assert.deepEqual(rq("juvenile arrests nationally in 2024").people?.where, [{ who: "arrestee", attr: "age", range: [1, 17], paired: false }]);
assert.equal(rq("What's the trend in negligent manslaughter cases over the past decade?").text.includes("cases"), false, "Jeff 2026-11-11: 'cases' is the normal count");
for (const q of ["disorderly conduct arrests in Ohio in 2024", "liquor law violation arrests in Ohio in 2024", "curfew arrests in Ohio in 2024", "trespassing arrests in Ohio in 2024"])
  assert.deepEqual(rq(q).ledger.parts.filter((x) => x.state === "not-interpreted").map((x) => x.text), [], q);

console.log("nibrs shadow reading: general wording forms read; boundaries keep their meaning");

// All years by default (Jeff 2026-11-11): "going back as far as possible" is by year with no range.
assert.equal(rq("indianapolis homicide counts going back as far as possible").text, "indianapolis homicide counts by year");
