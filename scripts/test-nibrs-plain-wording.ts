/**
 * P74 (Jeff 2026-11-01: "The answers need to be much, much more crystal clear for users"): the banned-word check on
 * plain and engine examples, and the reader's refusals reworded at the shadow's boundary. Every reason the reader
 * modules can give (lib/nibrs-question-types.ts, lib/nibrs-request-accounting.ts) has a plain wording, and every
 * wording is itself plain. The runtime walk over every case question is in scripts/test-nibrs-shadow.ts. Offline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { jargon, NOT_YET, plainPart, plainReaderText, REASONS, UNMAPPED } from "../lib/nibrs-shadow/wording";

// The banned list: engine words are caught; plain English is not (Codex plain-wording design check 3).
for (const engine of ["Not in the slice yet: rankings.", "This NIBRS shadow does not run Historical.", "(P01)", "P100", "no typed reading", "No plan form for this reading",
  "I can't apply \"2025\": one period per answer.", "I couldn't interpret it", "counted in its standard unit", "offense records", "Offenders are counted as NIBRS offender records",
  "measure all_crime.offenses", "v0 cannot group victim by offense_weapon.weapon", "the dimension", "two fields", "The plan did not validate", "contractProblems", "applied", "interprets"])
  assert.ok(jargon(engine).length > 0, `caught: ${engine}`);
for (const plain of ["The data records past crime and cannot predict the future.", "Reading the table, the rate rose.", "Memphis, Tennessee: 10,149 shoplifting offenses in 2024.",
  "Source: FBI NIBRS.", "e.g. a city", "Washington, D.C.", "McGregor Police Department (0 months)", "Clearances are recorded for each offense, not for each person.",
  "I didn't understand \"rolling over 12 months\". Try asking it another way.", NOT_YET])
  assert.deepEqual(jargon(plain), [], `plain: ${plain}`);
// The user's own words, quoted back, are not checked: an unread "unit" the user typed is not engine wording.
assert.deepEqual(jargon("I didn't understand \"per unit\". Try asking it another way."), []);

// Every reason literal the reader modules give has a plain wording here, and every wording is plain.
const reasonLiterals = (file: string) => {
  const src = fs.readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const line of src.split("\n")) if (/\bcannot\(|\bdeclined\(|"\s*:\s*"|\?\s*"|:\s*"/.test(line) && /cannot\(|declined\(|cannotReason|return "/.test(line))
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*\.)"/g)) out.add(m[1].replace(/\\"/g, '"'));
  return out;
};
const literals = new Set([...reasonLiterals("lib/nibrs-question-types.ts"), ...reasonLiterals("lib/nibrs-request-accounting.ts")]);
const known = (r: string) => r in REASONS || /^(?:NIBRS doesn't record|I couldn't|The earlier year|I can compare up to|This builds on|I couldn't rebuild)/.test(r);
const missing = [...literals].filter((r) => !known(r) && /^(?:[a-z]|I |NIBRS's|that |this |one |rates? |breakdowns? |clearance |comparisons |states |a )/.test(r));
assert.deepEqual(missing, [], "every reader reason has a plain wording");
for (const [reason, f] of Object.entries(REASONS)) assert.deepEqual(jargon(f("something")), [], `plain wording for: ${reason}`);

// The rewording itself: an unread phrase, a reason, a not-recorded sentence, and an unknown sentence (a plain
// fallback, recorded so the walk in test-nibrs-shadow.ts fails on it).
assert.equal(plainReaderText([{ text: "rolling over 12 months" }, { text: "to present", explanation: "I couldn't interpret \"to present\" in this question, so I haven't answered it with a number that ignores it." }]),
  "I didn't understand \"rolling over 12 months\" or \"to present\". Try asking it another way.");
assert.equal(plainReaderText([{ text: "victim", explanation: "I can't apply \"victim\": clearance figures count offense records, not other units. I haven't answered with a number that leaves it out." }]),
  "Clearances are recorded for each offense, not for each person, so they can't be counted by \"victim\".");
assert.equal(plainReaderText([{ text: "fentanyl", explanation: "NIBRS doesn't record fentanyl as its own drug type (it falls under broader narcotic categories), so I can't apply \"fentanyl\". I haven't answered with a number that leaves it out." }]),
  "NIBRS doesn't include fentanyl as its own drug type (it falls under broader narcotic categories), so \"fentanyl\" can't be counted.");
UNMAPPED.length = 0;
assert.deepEqual(plainPart({ text: "zzz", explanation: "Something the table has never seen." }), { sentence: "I couldn't use \"zzz\" in this question.", unmapped: "Something the table has never seen." });
plainReaderText([{ text: "zzz", explanation: "Something the table has never seen." }]);
assert.deepEqual(UNMAPPED, ["Something the table has never seen."]);
UNMAPPED.length = 0;

console.log("nibrs plain wording: engine words are caught, plain English passes; every reader reason has a plain wording");
