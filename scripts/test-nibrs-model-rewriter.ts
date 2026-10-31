/**
 * The model rewriter's guards (lib/nibrs-shadow/model-rewriter.ts): a model answer reaches the reader only when it
 * keeps the meaning of the previous question and the follow-up as the reader sees them; anything else, a malformed
 * answer or a cache miss is asked about with no options. Offline: hand-written model answers, no model, no database.
 */
import assert from "node:assert/strict";
import { bindingOf, cachedModelRewriter, cacheKey, guarded, meaningProblem, type ModelAnswer } from "../lib/nibrs-shadow/model-rewriter";
import { SYSTEM_PROMPT } from "../lib/nibrs-shadow/model-rewriter-prompt";
import type { Rewrite } from "../lib/nibrs-shadow/follow-up";

const g = (prev: string, f: string, a: ModelAnswer | null) => guarded(a, prev, f);
const placed = (r: Rewrite) => { assert.notEqual(r.kind, "ask", JSON.stringify(r)); return (r as Extract<Rewrite, { question: string }>).question; };
const asked = (r: Rewrite) => { assert.equal(r.kind, "ask", JSON.stringify(r)); assert.deepEqual((r as Extract<Rewrite, { kind: "ask" }>).options, []); return r; };
const rw = (question: string): ModelAnswer => ({ kind: "rewrite", question });
const Y = "Shoplifting in Memphis in 2024", M = "Shoplifting in Memphis by month in 2024";

// Faithful rewrites pass.
assert.equal(placed(g(Y, "what about Nashville?", rw("Shoplifting in Nashville in 2024"))), "Shoplifting in Nashville in 2024");
assert.equal(placed(g(Y, "also 2023", rw("Shoplifting in Memphis in 2023 and 2024"))), "Shoplifting in Memphis in 2023 and 2024");
assert.equal(placed(g(Y, "make it a rate", rw("Shoplifting rate in Memphis in 2024"))), "Shoplifting rate in Memphis in 2024");
assert.equal(placed(g(M, "make it quarterly", rw("Shoplifting in Memphis by quarter in 2024"))), "Shoplifting in Memphis by quarter in 2024");

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

// Presentation only when the follow-up names no data part; the data question is then the previous one exactly.
assert.equal(placed(g(M, "make it a bar chart", { kind: "presentation", question: "anything" })), M);
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
assert.equal(placed(model.rewrite(Y, "what about Nashville?")), "Shoplifting in Nashville in 2024");
asked(model.rewrite(Y, "what about Knoxville?"));
assert.equal(model.misses.length, 1);
assert.throws(() => cachedModelRewriter({ ...cache, binding: "other" }, binding), /another prompt, model or settings/);

console.log("nibrs model rewriter: guarded rewrites keep the reader's meaning; the rest, malformed answers and misses are asked");
