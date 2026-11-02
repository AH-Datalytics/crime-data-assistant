/**
 * The model rewriter's guards (lib/nibrs-shadow/model-rewriter.ts): a model answer reaches the reader only when it
 * keeps the meaning of the previous question and the follow-up as the reader sees them; anything else, a malformed
 * answer or a cache miss is asked about with no options. Offline: hand-written model answers, no model, no database.
 */
import assert from "node:assert/strict";
import { bindingOf, cachedModelRewriter, cacheKey, guarded, hybridRewriteAsync, hybridRewriter, meaningProblem, type ModelAnswer } from "../lib/nibrs-shadow/model-rewriter";
import { shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { SYSTEM_PROMPT } from "../lib/nibrs-shadow/model-rewriter-prompt";
import type { Rewrite } from "../lib/nibrs-shadow/follow-up";

const g = (prev: string, f: string, a: ModelAnswer | null) => guarded(a, prev, f);
const placed = (r: Rewrite) => { assert.notEqual(r.kind, "ask", JSON.stringify(r)); return (r as Extract<Rewrite, { question: string }>).question; };
/** A model rewrite is proposed (P69 amendment), never a direct rewrite. */
const proposed = (r: Rewrite) => { assert.equal(r.kind, "propose", JSON.stringify(r)); return (r as Extract<Rewrite, { kind: "propose" }>).question; };
const asked = (r: Rewrite) => { assert.equal(r.kind, "ask", JSON.stringify(r)); assert.deepEqual((r as Extract<Rewrite, { kind: "ask" }>).options, []); return r; };
const rw = (question: string): ModelAnswer => ({ kind: "rewrite", question });
const Y = "Shoplifting in Memphis in 2024", M = "Shoplifting in Memphis by month in 2024";

// Faithful rewrites pass.
assert.equal(proposed(g(Y, "what about Nashville?", rw("Shoplifting in Nashville in 2024"))), "Shoplifting in Nashville in 2024");
assert.equal(proposed(g(Y, "also 2023", rw("Shoplifting in Memphis in 2023 and 2024"))), "Shoplifting in Memphis in 2023 and 2024");
assert.equal(proposed(g(Y, "make it a rate", rw("Shoplifting rate in Memphis in 2024"))), "Shoplifting rate in Memphis in 2024");
assert.equal(proposed(g(M, "make it quarterly", rw("Shoplifting in Memphis by quarter in 2024"))), "Shoplifting in Memphis by quarter in 2024");

// Codex design check 1: the known ways of losing a part are caught.
asked(g(Y, "add 2023", rw("Shoplifting in Memphis in 2023")));                                   // an added year replaced the period
asked(g(Y, "also Nashville", rw("Shoplifting in Nashville in 2024")));                            // an added place replaced the place
asked(g(M, "make it a bar chart for 2023", { kind: "presentation", question: M }));                // presentation that drops 2023
asked(g(M, "make it a bar chart for 2023", rw(M)));                                               // a rewrite that drops 2023
asked(g(Y, "what about Nashville?", rw("Shoplifting in Nashville in 2023")));                    // the period changed unasked
asked(g(Y, "what about Nashville?", rw("Shoplifting rate in Nashville in 2024")));                // a rate nobody asked for
asked(g("Shoplifting in Memphis and Nashville combined in 2024", "compare to Knoxville",
  rw("Shoplifting in Memphis and Nashville and Knoxville combined in 2024")));                    // a place brought to a combined group
asked(g(M, "make it quarterly", rw(M)));                                                           // the follow-up's quarters are missing
asked(g(Y, "what about 2023?", rw("Shoplifting in Memphis in 2022")));                            // an invented year
assert.equal(meaningProblem(Y, "what about Nashville?", "Shoplifting in Nashville in 2024"), null);

// A model's presentation reading is asked about: only the baseline's supported wording keeps the data question.
asked(g(M, "make it a bar chart", { kind: "presentation", question: "anything" }));
// "new" only when the baseline's whole-question check agrees, and then the follow-up itself.
assert.equal(placed(g(Y, "How many robberies were there in Detroit in 2023?", { kind: "new", question: "Robberies in Detroit in 2023" })), "How many robberies were there in Detroit in 2023?");
asked(g(Y, "show shoplifting in Nashville in 2023 alongside that", { kind: "new", question: "Shoplifting in Nashville in 2023" }));

// Codex design check 2: the model's options are never used, and a malformed answer is asked about.
asked(g(Y, "what about Nashville or Knoxville?", { kind: "ask", why: "which place", options: [{ label: "Nashville", question: "Shoplifting in Nashville in 2024" }] }));
asked(g(Y, "x", null));
asked(g(Y, "x", { kind: "bogus" } as unknown as ModelAnswer));
asked(g(Y, "what about Nashville?", { kind: "rewrite" }));

// Codex design check 3: the cache is bound to the prompt and settings; a miss is asked about and counted.
const binding = bindingOf(SYSTEM_PROMPT);
const cache = { binding, entries: { [cacheKey(Y, "what about Nashville?")]: { previous: Y, followUp: "what about Nashville?", answer: rw("Shoplifting in Nashville in 2024"), raw: "", usage: { input: 0, output: 0, thinking: 0 } } } };
const model = cachedModelRewriter(cache, binding);
assert.equal(proposed(model.rewrite(Y, "what about Nashville?")), "Shoplifting in Nashville in 2024");
asked(model.rewrite(Y, "what about Knoxville?"));
assert.equal(model.misses.length, 1);
assert.throws(() => cachedModelRewriter({ ...cache, binding: "other" }, binding), /another prompt, model or settings/);

// The guard exceptions (Codex amendment check 4), each from a correct rewrite the 60-row sort found blocked, and only that.
const A = "Arrests in Denver in 2023 by arrestee race", S = "simple assault victims in Detroit by month in 2023";
assert.equal(proposed(g(A, "by ethnicity instead", rw("Arrests in Denver in 2023 by arrestee ethnicity"))), "Arrests in Denver in 2023 by arrestee ethnicity");
asked(g(A, "by ethnicity instead", rw("Arrests in Denver in 2023 by offender ethnicity")));           // the role changed
assert.equal(proposed(g(S, "This is a count. Is it possible to show a rate?", rw("simple assault victim rate in Detroit by month in 2023"))), "simple assault victim rate in Detroit by month in 2023");
asked(g(S, "This is a count. Is it possible to show a rate?", rw("simple assault victims in Detroit by month in 2023")));   // no rate
assert.equal(meaningProblem(Y, "y/y% change", "Year-over-year percent change in shoplifting in Memphis in 2024", { exceptions: false }) !== null, true);
asked(g(Y, "show the share", rw("Percent change in shoplifting in Memphis in 2024")));             // a change nobody asked for

// The hybrid (P69 amendment): the baseline's certain rewrites first and run directly; the model only where it asks.
const hy = hybridRewriter(model);
assert.equal(hy.rewrite(Y, "what about Nashville?").kind, "rewrite");                              // the baseline places it
assert.equal(hy.rewrite(Y, "why did it go up?").kind, "ask");                                       // neither: the baseline's ask

// A proposal runs nothing: no plan, no SQL, no continuation (Codex amendment check 1).
let ran = 0;
const deps = { places: loadPlaceIndex(), release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2024] }, execute: () => { ran++; return []; } } as unknown as ShadowDeps;
const stand = { rewrite: (): Rewrite => ({ kind: "propose", question: "Shoplifting in Nashville in 2024", how: "test" }) };
const o = shadowFollowUp(Y, "nashville pls", deps, stand);
assert.deepEqual(o, { kind: "proposal", question: "nashville pls", proposed: "Shoplifting in Nashville in 2024", how: "test", rewrite: "Shoplifting in Nashville in 2024", rewriteKind: "propose" });
assert.equal(ran, 0);

// A relative period the model works out ("the year before" -> 2023) is a year derived from the conversation, not a
// guessed one (coordinator, 2026-11-01); an unrelated year is still refused.
{
  const P = "Shoplifting in Memphis by year from 2021 to 2024";
  const derived = guarded({ kind: "rewrite", question: "Shoplifting in Memphis by year from 2017 to 2020" }, P, "and the four years before that, how did it compare");
  assert.notEqual(derived.kind === "ask" ? derived.why : "", "The rewrite named a number that is not in the conversation; ask the full question.");
  const unrelated = guarded({ kind: "rewrite", question: "Shoplifting in Memphis by year from 2017 to 2020" }, P, "what about Nashville");
  assert.equal(unrelated.kind, "ask");
  // Codex follow-up review 01.1: only the offset the follow-up names, and only for a follow-up about years.
  const S = "Shoplifting in Memphis in 2024";
  assert.equal(guarded({ kind: "rewrite", question: "Shoplifting in Memphis in 2040" }, S, "three years earlier").kind, "ask");
  assert.equal(guarded({ kind: "rewrite", question: "Shoplifting in Memphis in 2021" }, S, "three years earlier").kind, "propose");
  // Codex follow-up confirmation 02: the direction and a single offset count; 2027 and 2023 are not "three years earlier".
  for (const y of [2027, 2023]) assert.equal(guarded({ kind: "rewrite", question: `Shoplifting in Memphis in ${y}` }, S, "three years earlier").kind, "ask", String(y));
  assert.equal(guarded({ kind: "rewrite", question: "Shoplifting in Memphis in 2027" }, S, "three years later").kind, "propose");
  assert.equal(guarded({ kind: "rewrite", question: "Shoplifting in Memphis in 2040" }, S, "same as last time").kind, "ask");
  assert.equal(guarded({ kind: "rewrite", question: "Shoplifting offenders in Memphis in 2040" }, S, "the past offenders").kind, "ask");
}

// The live hybrid: deterministic first; the model only where it asks, through the guards, as a proposal; no answer or a
// failing call falls back to the baseline's ask.
(async () => {
  const P = "Carjacking offenses in Memphis by month in 2024";
  let calls = 0;
  const model = async () => { calls++; return { kind: "rewrite", question: "Carjacking offenses in Memphis by month in 2022" }; };
  const direct = await hybridRewriteAsync(P, "show me 2023", model);
  assert.equal(direct.kind === "rewrite" && direct.question, "Carjacking offenses in Memphis by month in 2023");
  assert.equal(calls, 0, "a certain deterministic rewrite never calls the model");
  const proposed = await hybridRewriteAsync(P, "and maybe the one two years back", model);
  assert.ok(proposed.kind === "propose" && proposed.question === "Carjacking offenses in Memphis by month in 2022", JSON.stringify(proposed));
  assert.equal(calls, 1);
  assert.equal((await hybridRewriteAsync(P, "and maybe the one two years back", async () => null)).kind, "ask");
  assert.equal((await hybridRewriteAsync(P, "and maybe the one two years back", async () => { throw new Error("quota"); })).kind, "ask");
  assert.equal((await hybridRewriteAsync(P, "hmm that seems off", async () => ({ kind: "rewrite", question: "Murders in Chicago in 1990" }))).kind, "ask", "the guards still apply");
  console.log("nibrs model rewriter: guarded rewrites keep the reader's meaning; the rest, malformed answers and misses are asked");
})().catch((e) => { console.error(e); process.exit(1); });
