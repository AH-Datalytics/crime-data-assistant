# The labeled interaction set (answer evaluation, part 2)

**Owner's goal (2026-10-28, relayed):** the app answers "like a professional app: correct answer, asks clarifying, or
says it can't answer. All correctly." This set is how that is measured. It builds on what exists:
- the frozen gold set (`docs/superpowers/2026-09-06-correctness-gold-set-v7.json`, sha256 24e4d150...80c3b);
- the 605-question NIBRS replay inventory;
- the correctness set;
- the answer policy table (`docs/policy/nibrsai-answer-policy.csv`).

There is no evaluation platform: a JSON file, a schema and a runner.

## Files

- `lib/answer-eval/case.ts`: the case schema (zod) and `scorable()`.
- `scripts/build-answer-eval-seed.py`: builds the question side of `scripts/fixtures/answer-eval/cases.json`. It
  keeps any label already written.
- `scripts/test-answer-eval-cases.ts`: the file is well formed, groups never straddle the split, buttons answer a
  clarifying case, and policy rows exist.

## Selection (218 cases)

| Origin | Cases | What |
|---|---|---|
| gold | 120 | every frozen gold case: real logged questions on all five tabs, with setup turns for the 14 follow-ups; each carries its frozen rules as policy rows D01-D17 |
| replay | 36 | NIBRS replay questions not in the gold set, one per normalized wording, round-robin over the reachability categories in hash order (no follow-ups, nothing chosen by today's outcome) |
| designed | 62 | questions for each open policy row (P01-P24) and the decided rows without gold coverage; paraphrase groups; two conversations; three button continuations |

**Held out:** 27 cases, chosen as whole groups by a hash of the group id, so paraphrases and conversation turns stay
together. They are not used while building or tuning a candidate. They are scored separately.

## A label

Each case expects one action and the exact meaning behind it (`Expected`):
- **answer**: the meaning, plus:
  - `values`: `verified` cells from an independent source (a correctness case, an archive extract), `pending_build`
    until the canonical build can produce them, or `not_checkable`;
  - `statements`: what the explanation must say, as a gist (for example "names the sheriff's agency", "names the
    months covered").
- **clarify**: what is being asked, and the options. Each option has the meaning it leads to: the original question
  with that choice filled in, place, period and filters kept, never asked again. An option may lead to a decline.
- **decline**: a truthful reason, plus the nearest alternative only when one genuinely exists and can run, otherwise
  `null`.

**Meaning** is source-neutral:
- source; places; period (months, or a named rule such as "latest complete year");
- measures with units; filters; groupings;
- statistic; denominator; cohort; rank.

The runner maps a candidate's plan onto it. Measure names are plain ("murder", "aggravated assault") with units
("victim", "offense", "incident", "arrest", "dollars", "officer").

## Labeling rules

1. **Independent of every candidate.**
   - Drafters never read today's responses or logged outcomes (`outcome_then`, `decision_then`, saved answers).
   - Today's site is a comparator, not the answer key.
   - Labels follow the policy table and the frozen rules.
2. **Decided rows bind.** Each gold case's expectation must satisfy every frozen rule it carries.
3. **Open rows (P01-P24).** The label follows the row's *proposed* behavior and lists the row in `policy`, so the case
   stays unscored until Jeff decides. A different decision means relabeling, never quietly reinterpreting.
4. **A model drafts; it is never the only judge.**
   - Drafted labels carry `drafted_by`.
   - A label counts only after review by a different judge (`reviewed_by`): Codex in one pass (the owner's tier for
     labels), and Jeff for anything he flags.
5. **Unresolved stays unscored.** When the right action or meaning cannot be established (the data condition is
   unknown, or the question is unreadable), the label is `unresolved` with a reason. Its count is always reported.
6. **Values are never inferred from a response.** They come from independently reviewable rows (the gold set's
   ground-truth rule).

## Scoring (the runner and gates, parts 4-5)

A case is scored only when it is reviewed and none of its policy rows is open (`scorable()`). Every report states:
- how many cases were unscored, and why: open policy, unreviewed, unresolved;
- the held-out results separately.
