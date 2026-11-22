/**
 * The NIBRS crime-against family (P202, coordinator 2026-11-22), the engine's side, offline: each category's codes are the CDE codebook's
 * crime_against value for the Group A codes (09C, no crime, out of persons); the answer calls a category asked by name by its name, and keeps
 * "violent crime" / "property crime" when the plan says those were asked (Jeff 2026-11-15; P167).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { GROUP_B, MEASURE_CODES } from "../lib/nibrs-question-types";
import { ASKED_AS_PROPERTY, ASKED_AS_VIOLENT } from "../lib/nibrs-plan/from-spec";
import { measureWords } from "../lib/nibrs-shadow/deliver";
import type { NibrsPlan } from "../lib/nibrs-plan/plan";

console.log("crime against: persons, property and society from the codebook; named as asked");

// --- Codes: the codebook's crime_against, Group A only.
const lines = fs.readFileSync("scripts/fixtures/cde/NIBRS_OFFENSE_TYPE.csv", "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
/** One CSV line's fields (quoted fields may hold commas: "Human Trafficking, Commercial Sex Acts"). */
const fields = (l: string): string[] => [...l.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]));
const head = fields(lines[0]);
const code = head.indexOf("offense_code"), against = head.indexOf("crime_against"), group = head.indexOf("offense_group");
const byAgainst = new Map<string, string[]>();
for (const l of lines.slice(1)) {
  const f = fields(l);
  const c = f[code];
  // Group A only, by the codebook's own offense_group (it lists federal Group B codes, 90K-90M, that the engine's GROUP_B does not).
  if (!/^[0-9A-Z]{3}$/.test(c) || f[group] !== "A") continue;
  assert.ok(!GROUP_B.has(c), `${c} is Group A in the codebook`);
  byAgainst.set(f[against], [...(byAgainst.get(f[against]) ?? []), c]);
}
const sorted = (xs: string[]) => [...xs].sort();
assert.deepEqual(sorted(MEASURE_CODES.person_crimes), sorted(byAgainst.get("Person")!.filter((c) => c !== "09C")), "persons: the codebook's Person codes, justifiable homicide out");
assert.deepEqual(sorted(MEASURE_CODES.against_property), sorted(byAgainst.get("Property")!), "property: the codebook's Property codes");
assert.deepEqual(sorted(MEASURE_CODES.against_society), sorted(byAgainst.get("Society")!), "society: the codebook's Society codes");

// --- Names: asked by name, or reached from violent / property crime.
const plan = (id: string, unit: string, reason?: string) => ({ measures: [{ id, unit, as: "x" }], filters: [], defaults: reason ? [{ path: "measures[0]", value: id, reason }] : [] }) as unknown as NibrsPlan;
assert.equal(measureWords(plan("victims.person_crimes", "victim")), "victims of crimes against persons");
assert.equal(measureWords(plan("offenses.against_property", "offense")), "crimes against property");
assert.equal(measureWords(plan("offenses.against_society", "offense")), "crimes against society");
assert.equal(measureWords(plan("offenders.person_crimes", "offender")), "offenders in crimes against persons");
assert.equal(measureWords(plan("victims.person_crimes", "victim", ASKED_AS_VIOLENT)), "violent crime victims", "violent crime by age keeps its words");
assert.equal(measureWords(plan("victims.against_property", "victim", ASKED_AS_PROPERTY)), "property crime victims", "property crime by a victim's age keeps its words");
assert.equal(measureWords(plan("victims.person_crimes", "victim", "P167: violent crime with a weapon is counted as crimes against persons")), "violent crime victims", "P167 keeps its words");

console.log("crime against: 10 passed, 0 failed");
