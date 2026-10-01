/**
 * GC-003: a "where" that names no level is asked about in owned wording, and stays pending until a
 * reply names one (lib/where-level-clarification.ts, lib/followup-transform.ts; Codex review CL2). An
 * explicit or carried level, a named comparison, a relative "where" and a non-ranking "where" are left
 * alone.
 */
import assert from "node:assert";
import { pendingWhereLevel, pendingWhereLevelReask, whereLevelClarification, whereLevelReply, WHERE_LEVEL_CLARIFICATION_QUESTION } from "../lib/where-level-clarification";
import { buildQueryContract } from "../lib/query-contract";
import { detectFollowupTransform } from "../lib/followup-transform";
import { requestedScope } from "../lib/structural-semantics";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message.split("\n")[0]}`); }
}
const asks = (q: string) => whereLevelClarification({ question: q, contract: buildQueryContract(q, "nibrs") });

const GC003 = "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?";

check("GC-003 is asked which level, in owned wording, with an explicit disposition", () => {
  const out = asks(GC003);
  assert.ok(out);
  assert.strictEqual(out!.explanation, WHERE_LEVEL_CLARIFICATION_QUESTION);
  assert.match(out!.explanation, /by state, by city, or by individual police agency/);
  assert.match(out!.disposition, /^clarification: .*not met by it$/);
});
check("siblings that ask where with no level are asked too", () => {
  assert.ok(asks("Where did murders rise the most in 2025?"));
  assert.ok(asks("where had the most robberies in 2024"));
});
check("an explicit level is not asked about", () => {
  assert.strictEqual(asks("what crime type and which cities had the highest share of offenses cleared because of prosecution being declined in 2025?"), null);
  assert.strictEqual(asks("what crime type and where had the highest share cleared by prosecution declined in 2025, by state?"), null);
  assert.strictEqual(asks("Which states have the highest share of rapes cleared by exception in 2025? And where?"), null);
});
check("a level carried into the reconstructed request counts as stated", () => {
  // The route passes its reconstructed question; a carried "by agency" is part of it.
  assert.strictEqual(asks(`${GC003} by agency`), null);
});
check("a kind of place the level cues do not list still names the level", () => {
  // "towns", "jurisdictions": not a state/city/county/agency cue, but a named kind of place all the same.
  assert.strictEqual(asks("Where had the highest murder rate in 2025 among towns?"), null);
  assert.strictEqual(asks("where, among jurisdictions, was the share of offenses cleared by arrest highest in 2025?"), null);
});
check("two named places compare those places; no level is missing", () => {
  assert.strictEqual(asks("Where was murder higher in 2024, Chicago or Houston?"), null);
  // With ranking wording, so the named-comparison rule itself is what decides.
  assert.strictEqual(asks("Where was murder highest in 2024, Chicago or Houston?"), null);
});
check("a relative where, and a where that asks for no ranking, are left alone", () => {
  assert.strictEqual(asks("How many offenses where the offender was a juvenile in 2024?"), null);
  assert.strictEqual(asks("Where can I find the data?"), null);
});
/* ---- CL2: a pending choice stays pending until it is answered, and the answer is consumed ---- */
const PENDING = [
  { role: "user" as const, content: GC003 },
  { role: "assistant" as const, content: WHERE_LEVEL_CLARIFICATION_QUESTION },
];
check("CL2: an unanswered repeat of the same ambiguous request is asked again (asked is not answered)", () => {
  assert.ok(pendingWhereLevel(PENDING));
  assert.ok(asks(GC003), "the repeated request still names no level");
});
check("CL2: a reply naming one level is recognized; anything else is not an answer", () => {
  assert.strictEqual(whereLevelReply("By state"), "state");
  assert.strictEqual(whereLevelReply("states please"), "state");
  assert.strictEqual(whereLevelReply("cities"), "city");
  assert.strictEqual(whereLevelReply("individual police agencies"), "agency");
  assert.strictEqual(whereLevelReply("rank it by state"), "state");
  assert.strictEqual(whereLevelReply("states or cities"), null);
  assert.strictEqual(whereLevelReply("which states had the most murders in 2024?"), null);
  assert.strictEqual(whereLevelReply(GC003), null);
});
check("CR-2: only a whole affirmative choice counts -- a negation or a non-answer chooses nothing", () => {
  for (const q of ["Not by state", "not cities", "I don't know", "no", "either", "hmm", "anything but states"]) {
    assert.strictEqual(whereLevelReply(q), null, q);
    assert.strictEqual(detectFollowupTransform(q, PENDING)?.name === "resolve_where_level", false, `${q} resolved the choice`);
  }
});
check("CR-2: while pending, a non-answer asks again in owned wording and keeps the question pending", () => {
  for (const q of ["Not by state", "I don't know", "hmm"]) {
    const out = pendingWhereLevelReask({ question: q, contract: buildQueryContract(q, "nibrs"), history: PENDING });
    assert.ok(out, q);
    assert.match(out!.explanation, /^I still need to know which level you mean before I can build that\. Where do you want that ranked/);
    assert.ok(pendingWhereLevel([...PENDING, { role: "user", content: q }, { role: "assistant", content: out!.explanation }]), "still pending afterward");
  }
});
check("CR-2: a choice made after a re-ask resolves the ORIGINAL request, not the non-answer before it", () => {
  const after = [...PENDING, { role: "user" as const, content: "I don't know" },
    { role: "assistant" as const, content: `I still need to know which level you mean before I can build that. ${WHERE_LEVEL_CLARIFICATION_QUESTION}` }];
  const t = detectFollowupTransform("cities", after);
  assert.ok(t && t.name === "resolve_where_level");
  assert.strictEqual(t!.contextQuestion, "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025, ranked by city?");
  assert.doesNotMatch(t!.instruction, /I don't know/);
});
check("AR-1: a choice after a NEWER request's clarification resolves the newer request, never the abandoned one", () => {
  const NEW = "Where did murders rise the most in 2024?";
  const superseded = [...PENDING, { role: "user" as const, content: NEW }, { role: "assistant" as const, content: WHERE_LEVEL_CLARIFICATION_QUESTION }];
  const t = detectFollowupTransform("By state", superseded);
  assert.ok(t && t.name === "resolve_where_level");
  assert.strictEqual(t!.contextQuestion, "Where did murders rise the most in 2024, ranked by state?");
  assert.doesNotMatch(t!.instruction, /prosecution/);
  // Control: the new request alone gives the same result.
  assert.strictEqual(detectFollowupTransform("By state", [{ role: "user", content: NEW }, { role: "assistant", content: WHERE_LEVEL_CLARIFICATION_QUESTION }])?.contextQuestion,
    t!.contextQuestion);
});
check("AR-1: a non-answer after a newer request is walked back only to that newer request", () => {
  const NEW = "Where did murders rise the most in 2024?";
  const history = [...PENDING, { role: "user" as const, content: NEW }, { role: "assistant" as const, content: WHERE_LEVEL_CLARIFICATION_QUESTION },
    { role: "user" as const, content: "I don't know" }, { role: "assistant" as const, content: `I still need to know which level you mean before I can build that. ${WHERE_LEVEL_CLARIFICATION_QUESTION}` }];
  assert.strictEqual(detectFollowupTransform("cities", history)?.contextQuestion, "Where did murders rise the most in 2024, ranked by city?");
});
check("CR-2: an affirmative choice, a new request, or no pending question is not re-asked", () => {
  const reask = (q: string, h = PENDING) => pendingWhereLevelReask({ question: q, contract: buildQueryContract(q, "nibrs"), history: h });
  assert.strictEqual(reask("By state"), null);
  assert.strictEqual(reask("which states had the most murders in 2024?"), null);
  assert.strictEqual(reask("How many robberies were there in Texas?"), null);
  assert.strictEqual(reask("I don't know", [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello." }]), null);
});
check("CL2: the reply resolves the pending choice into the original request, carrying the level", () => {
  const t = detectFollowupTransform("By state", PENDING);
  assert.ok(t && t.name === "resolve_where_level", `transform ${t?.name}`);
  assert.strictEqual(t!.contextQuestion, "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025, ranked by state?");
  assert.match(t!.instruction, /ranked by state/);
  assert.strictEqual(asks(t!.contextQuestion!), null, "the resolved request names its level, so it is not asked again");
  const contract = buildQueryContract(t!.contextQuestion!, "nibrs")!;
  assert.strictEqual(requestedScope(t!.contextQuestion!, contract).rowLevel, "state", "the level reaches the request the plan reads");
});
check("CL2: a reply is resolved only while the clarification is the latest assistant turn", () => {
  const answeredElsewhere = [...PENDING, { role: "user" as const, content: "never mind" }, { role: "assistant" as const, content: "Okay." }];
  assert.strictEqual(pendingWhereLevel(answeredElsewhere), false);
  assert.strictEqual(detectFollowupTransform("By state", answeredElsewhere)?.name === "resolve_where_level", false);
});
check("CL2: a self-contained new request supersedes the pending one and is judged on its own words", () => {
  assert.strictEqual(asks("what crime type and which states had the highest share of offenses cleared because of prosecution being declined in 2025?"), null);
  assert.strictEqual(detectFollowupTransform("which states had the most murders in 2024?", PENDING)?.name === "resolve_where_level", false);
});

console.log(`\nWhere-level clarification: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
