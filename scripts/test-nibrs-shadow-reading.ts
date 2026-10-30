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
assert.equal(read("robberies in Tulsa by weapon and year").readings.length, 0, "only the delivered categories");
assert.equal(read("Simple assaults committed by men and women in Tulsa in 2023").readings.length, 0, "offenders, not victims: left alone");
// P29 (Jeff): "by" names the offenders, "against" names the victims.
assert.equal(read("robberies against men and women in Tulsa in 2022").text, "robberies by sex in Tulsa in 2022");
for (const q of ["assaults by men and women in Tulsa", "burglaries committed by juveniles in Tulsa", "robberies by women in Tulsa"]) assert.equal(read(q).offenders, true, q);
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

// Every rewrite is recorded on the ledger the reader reads.
const l = read("Shoplfting in Tulsa so far this year").ledger;
assert.deepEqual(l.readings.map((r) => r.kind), ["period", "spelling"]);
assert.equal(l.question, "Shoplifting in Tulsa in 2026");

console.log("nibrs shadow reading: general wording forms read; boundaries keep their meaning");
