# A model-backed follow-up rewriter, tested in the shadow

Jeff (2026-10-31, through the coordinator): "yes, we should at least test an ai followup". This is a test in the NIBRS shadow, run before increment 8. It changes no live route.

## What it is

The model rewriter is a second implementation of `FollowUpRewriter` (lib/nibrs-shadow/follow-up.ts), the interface built in 7b. It takes the previous turn's question and the follow-up text. It returns exactly one of these:
- a standalone question and its kind (`rewrite`, `new` or `presentation`), always marked certain;
- an `ask`, with a reason and with zero or more options, where each option is a complete question.

The rewrite then goes through the normal reader, plan, compiler and delivery path, unchanged (P69). The model produces wording only. It never produces numbers, a plan or SQL.

## Model

`gemini-3.8-flash`, the app's provisional model (Codex provisional-choice ruling, 2026-09-23, in docs/roadmap/current.md). It is called on the Gemini API's `generateContent` endpoint with a JSON response schema, temperature 0, and thinking level "low" (the endpoint refuses "minimal" for this model).

The key is the existing `GEMINI_API_KEY` from the local User environment. It is passed to the process and never printed or logged, and no request or response record contains it.

## Synchronous interface, cached responses

`FollowUpRewriter.rewrite` is synchronous, and the scored run must be reproducible offline. So the work is split in two:
- `scripts/fetch-model-rewrites.ts` (async, online). It sends each (previous, follow-up) pair once and saves the parsed response with its token usage. The cache file is scripts/fixtures/answer-eval/model-rewrites/gemini-3.8-flash.json.
  - The cache key is a sha256 of: model id, prompt version, previous question, follow-up.
  - Progress is saved incrementally and the cost is tracked as calls return. The script stops before the next call would pass the budget: $4.50 hard stop, under the $5 the coordinator approved.
- `cachedModelRewriter(cache)`. It is synchronous and offline: it looks up the pair. A missing entry is an `ask` that says so, so a missing response is never treated as a guess. The scored run reports any missing entries.

Live use would need an async rewriter. That is a later decision, not part of this test.

## Guards (code, not the model)

The model's answer is checked before it is used. If any check fails, the result is an `ask`, never a partial guess (rule 2 from 7b):
- The response must parse against the schema: kind, plus question, or plus why and options.
- The question must be non-empty and at most 300 characters.
- **No invented numbers:** every number in the question (years, ages, populations) must appear in the previous question or the follow-up.
- `presentation` must return the previous question unchanged.
- `new` must not reuse the previous question's text when the follow-up names its own crime, place and period. This is not checked: it is advisory only and recorded.
- Option questions get the same checks.

## The prompt

Prompt version `rw-1`.
- It states P69's rules: one standalone question; only the previous turn is used; presentation edits keep the data question; ask when uncertain.
- It states the 7b lessons as rules:
  - take the whole follow-up;
  - keep additive and comparative intent;
  - never overwrite a period that was asked;
  - never join a combined group without asking;
  - with an ambiguous target, ask;
  - an option's question must do exactly what its label says.
- It has eight short worked examples. None comes from LS-403..LS-426 or from the query log, so the scored cases and the measurement are not leaked into the prompt.

## Measurement (reported before the PR)

1. **The 693 logged follow-ups.** Each is run against the same three synthetic previous questions as scripts/report-follow-up-coverage.ts. Reported:
   - placed versus asked, per kind, compared with the deterministic baseline (103 placed, 590 asked);
   - placed by both rewriters, by one only, and by neither.
2. **Hand check.** A random sample of 50 model rewrites (fixed seed), checked by hand for correctness: does the rewrite mean what the follow-up asked, given the previous question? A rewrite that changes the meaning is the failure that matters. The sample and each verdict are committed with the results.
3. **LS-403..LS-426.** These run through `shadowFollowUp` with the cached model rewriter and are scored by the existing scorer. Zero wrong answers are required.

## Cost estimate (before any call)

- Calls: 693 × 3 = 2,079 for the measurement, plus 24 for the cases and about 10 probes. That is about 2,113 in all, fewer after deduplicating identical pairs.
- Input: about 1,100 tokens per call (instructions, 8 examples, the pair), about 2.3M in all, or $1.74 at $0.75 per million.
- Output: about 80 tokens per call, plus thinking at its minimum, assumed 150 at most. That is about 0.5M in all, or $1.82 at $3.75 per million.
- **Estimate: about $3.60. The hard stop is $4.50.** The script reports the actual cost from the usage the endpoint returns.

## Out of scope

- No live route.
- No change to the deterministic rewriter.
- No new scoring rule except the cache-miss report.

## Codex design check (2026-10-31): ACCEPT WITH CHANGES, applied before any call

1. **Meaning guard.** `meaningProblem` compares what the reader finds in the previous question, the follow-up and the rewrite: concepts, values and flags. Each check catches a known way of losing a part; together they do not prove the meaning is the same.
   - Every part the follow-up names must be in the rewrite, a period's years included.
   - Every part the follow-up does not touch must be kept exactly, and so must the flags (people, quarters, columns) when the follow-up sets none.
   - Additive or comparative wording must keep the previous places or years.
   - A place brought to a combined group is asked about.
   - The rewrite must have no unread words.
   - Presentation counts only when the follow-up names no data part; the data question is then the previous one, exactly.
2. **No model options; "new" confirmed by the baseline.** The model's options are never used, because shadowFollowUp would run each one. A failure or a cache miss is an `ask` with no options. A "new" question counts only when the deterministic whole-question check agrees, and the follow-up itself is used.
3. **Cache binding.** The cache records a binding: a sha256 of the model, the prompt version, the exact prompt text and the generation settings. A cache with a different binding is refused. Guards apply when the cache is read, and malformed entries are asked about. Results report the cache hash, the binding and the guard version (`g-1`).
4. **Measurement definitions, fixed before fetching.**
   - A logged row counts as placed if any of its three contexts is placed, in the baseline's context order. 693 rows are compared, not 2,079 pairs.
   - The 50-rewrite sample is drawn uniformly from every accepted pair-level output, all kinds, with a fixed seed.
   - LS-403..LS-426 are regression evidence, not unseen data: the prompt states lessons learned on that work.
   - Wrong actions, unverified cases and cache misses are reported apart from wrong answers.
5. **Budget enforced before dispatch.**
   - The output is capped at 512 tokens, thinking included.
   - Each attempt, retries included, is sent only if the spend so far plus its worst case fits within $4.50. The worst case is the input estimated high plus the full output cap at the output price.
   - Requests go one at a time.
   - Spend persists in the cache across resumes.
   - A response with no usage stops the run.
