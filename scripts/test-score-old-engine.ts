/**
 * Scoring gap 2: the old app's logged replies read as answer, clarify or decline (scripts/score-old-engine.ts), and the
 * label ids made as draft-qlog-labels.py makes them. Replies here are written for the test, not taken from the log.
 */
import assert from "node:assert/strict";
import { labelId, oldAbout, oldGot } from "./score-old-engine";

// Label ids: a first question by its words; a follow-up by the turn before and its own words.
assert.match(labelId({ tab: "nibrs", question: "Robberies in Memphis in 2024?", n: 1 })!, /^QL-nibrs-[0-9a-f]{10}$/);
assert.equal(labelId({ tab: "nibrs", question: "robberies   in memphis in 2024", n: 1 }), labelId({ tab: "nibrs", question: "Robberies in Memphis in 2024?", n: 1 }));
assert.match(labelId({ tab: "current", question: "and in 2023", n: 2, previous: "Robberies in Memphis in 2024" })!, /^QL-ct-[0-9a-f]{10}$/);
assert.equal(labelId({ tab: "other", question: "x", n: 1 }), null);

// Answers: rows from a query, the tab's source.
assert.deepEqual(oldGot({ tab: "current", sql: "SELECT 1", rows: 12 }), { kind: "answer", source: "rtci", ms: 0 });
assert.deepEqual(oldGot({ tab: "shr", sql: "SELECT 1", rows: 3 }), { kind: "answer", source: "shr", ms: 0 });
// A failed query is the old app's error; a guard's tag on a delivered reply is not (Codex gap-2 review 01.3); a query
// with no rows answered nothing.
assert.equal(oldGot({ tab: "nibrs", sql: "SELECT x", rows: 0, error: "DB: Schema validation failed: no such column: d.age" }).kind, "error");
assert.equal(oldGot({ tab: "nibrs", sql: "SELECT x", rows: 0, error: "raw_table_second_failure", response: "I wasn't able to build a valid query." }).kind, "error");
assert.equal(oldGot({ tab: "shr", error: "nonfatal_shooting_refusal", response: "This database does not track nonfatal shootings." }).kind, "decline");
assert.equal(oldGot({ tab: "nibrs", sql: "SELECT 1", rows: 4, error: "guardrail_override" }).kind, "answer");
// Answers without SQL (data completeness), and a reply that fits no form: left out, never guessed.
assert.equal(oldGot({ tab: "nibrs", rows: 0, guardrails: "completeness-deterministic", response: "NIBRS covers 2024 for 16,000 agencies." }).kind, "answer");
assert.equal(oldGot({ tab: "nibrs", response: "Here are the offense codes, grouped." }).kind, "unclassified");
// The app's own outcomes win over a deterministic plan's tag (Codex gap-2 review 02.1, the SHR route's replies), and a
// guard's refusal naming "multiple agencies" is a decline, not a which-place question (02.2, lib/guardrails.ts).
assert.deepEqual([oldGot({ tab: "shr", rows: 0, error: "ambiguous_city", guardrails: "[\"deterministic-shooting\"]", response: "Please specify Kansas City, Missouri (KCMO) or Kansas City, Kansas (KCK). Both exist in the SHR data, and I should not combine or choose between them without that state." }).kind,
  oldGot({ tab: "shr", rows: 0, error: "ambiguous_city", guardrails: "[\"deterministic-shooting\"]", response: "Please specify Kansas City, Missouri (KCMO) or Kansas City, Kansas (KCK)." }).about], ["clarify", "which"]);
assert.equal(oldGot({ tab: "shr", rows: 0, error: "shr_ori_not_in_source", guardrails: "[\"deterministic-shooting\",\"shr-place-resolution-block\",\"shr-ori-not-in-source\"]", response: "I could not find ORI XX0000000 in the SHR agency identity data, so I cannot return a reliable result." }).kind, "decline");
assert.equal(oldGot({ tab: "shr", sql: "SELECT 1", rows: 0, error: "sql_guardrail", response: "SHR population data is per-agency and per-incident — summing it across multiple agencies produces unreliable rates. For aggregate murder rates, try the Historical Library tab. I can provide raw victim counts from SHR instead." }).kind, "decline");
// A decline that offers something else is a decline; a plain question back is a clarify.
assert.equal(oldGot({ tab: "current", response: "This tab is not available for staffing. Do you want the Historical tab instead?" }).kind, "decline");
assert.equal(oldGot({ tab: "current", response: "Which year?" }).kind, "clarify");
assert.deepEqual([oldGot({ tab: "nibrs", sql: "SELECT 1", rows: 0 }).kind, oldGot({ tab: "nibrs", sql: "SELECT 1", rows: 0 }).reason], ["decline", "no rows"]);
// Words not understood: the reader's decline ("try asking another way").
assert.equal(oldGot({ tab: "historical", response: "I could not generate a database query for that request. Please restate it." }).reason, "reader");
// Clarifying replies, by what they ask.
const ask = (response: string) => { const g = oldGot({ tab: "nibrs", response }); assert.equal(g.kind, "clarify", response); return g.about; };
assert.equal(ask("Say Washington, DC or Washington state to avoid ambiguity."), "which");
assert.equal(ask("Kansas City can mean Missouri or Kansas."), "which");
assert.equal(ask("For Alameda County, do you want the countywide total or the sheriff's office?"), "which");
assert.equal(ask("I need clarification: which cities would you like to compare Memphis to?"), "place");
assert.equal(ask("I need to clarify which years you want."), "period");
assert.equal(ask("I need to clarify: do you mean victims' race or offenders' race?"), "victims or offenders");
assert.equal(ask("There are two common definitions; do you mean violent crime or property crime?"), "violent, property or both");
assert.equal(oldAbout("I need to clarify something."), "unclassified");
// A plain statement of what isn't recorded is a decline.
assert.equal(oldGot({ tab: "nibrs", response: "NIBRS does not track whether DNA evidence was used in a case." }).kind, "decline");

console.log("score-old-engine: logged replies read as answer, clarify or decline; label ids as the drafter makes them");
