# P3.1a — response to candidate review round 1

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round1.md` (SHA-256 `B708FEB2…`)
**Status:** corrections applied; **stopped before executing any frozen case**, as instructed.

---

## 0. The one sentence that matters most

**No frozen case has been executed as evidence.** The 63-case runner exists, is frozen, and has
never produced a result. `docs/superpowers/p3-1a/runs/` does not exist. §7 states precisely what
*was* run against frozen inputs and why that is not the same thing — read it before accepting §3.

---

## 1. Candidate identity

The superseded candidate is preserved unmodified and remains reachable in branch history.

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Superseded candidate** | `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b` (tree `26083c06…`) — untouched |
| **Corrected candidate (tip)** | `9a19e1045ad051afc60cb53efd8d56bd93f952b7` |
| Corrected tree | `96d0888043fc2e49df6bee7e8e5a9a5475844622` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Parent chain | `9a19e10` → `48885ab` → `5143ea4` → `c567f4a` → `e2d24ac` |

Three commits rather than one. The review asked for "a corrected candidate"; I kept the blocker
work, the BASE differential and the shell de-duplication as separate commits so each is reviewable
on its own. If a single squashed candidate is preferred, say so and I will produce it — I have not
squashed on my own because that would rewrite `c567f4a`'s child and I was told to preserve it.

### Path set

New:

| Path | sha256 (first 16) | Bytes |
|---|---|---|
| `lib/capability-decision.ts` | `3bde5ffcc1b9f486…` | 4,022 |
| `scripts/run-p3-1a-frozen-cases.ts` | `c348e3bf5964e6f0…` | 15,805 |
| `scripts/test-p3-1a-case-runner.ts` | `c3039402cac3cf7d…` | 11,252 |
| `scripts/test-p3-1a-base-parity.ts` | `70158813f93fd60b…` | 7,685 |
| `scripts/lib-p3-1a-postsql-grid.ts` | `751b1a3257f5dd1c…` | 3,353 |
| `scripts/fixtures/p3-1a-base-postsql-baseline.json` | `f9c4ecb1ff2c7d4b…` | 282,184 |
| `docs/superpowers/p3-1a/base-capability-sets.json` | `6047b405c54f31cc…` | 1,516 |

Changed:

| Path | sha256 (first 16) | Change |
|---|---|---|
| `lib/request-decision-observer.ts` | `98efa9b9c5256cfe…` | +18 lines: emits the shared typed outcome |
| `lib/query-contract-validator.ts` | `c83250c15086b11d…` | +8 / −42: two private sets replaced by one shared import |
| `scripts/test-request-decision-observer.ts` | `4b608b3039dcae3f…` | rewritten: 16 → 32 controls |
| `package.json` | — | one line: two suites added to `harness:test` |
| `scripts/fixtures/harness-tier-manifest.json` | — | +18: two Tier F entries |

Also carried onto the branch: `frozen-cases-v1/v2/v3.json`, `verify-frozen-cases-v2/v3.js`, and
`evidence/tigerweb_bas26_incplace_2025_acs25_ar.html`, previously untracked in the developer
checkout. Committing them is what makes "frozen" enforceable rather than a claim about a file on
one workstation.

**Total production change: three files, +116 / −42 lines.** Everything else is test, fixture,
frozen artifact or manifest.

---

## 2. Finding → file map

| # | Finding | Where it is addressed |
|---|---|---|
| **B1** | Emit the shared production typed decision/reason | `lib/capability-decision.ts` (new authority); `lib/query-contract-validator.ts:~50` (private sets deleted, shared import added); `lib/request-decision-observer.ts` `ObservationRecord.outcome` / `.classification`; controls C2, C3 |
| **B1** | Flags-off regression vs BASE over findings, retry issues, block reasons, enforced ids, finalization | `scripts/lib-p3-1a-postsql-grid.ts`, `scripts/fixtures/p3-1a-base-postsql-baseline.json` (captured at BASE), `scripts/test-p3-1a-base-parity.ts` (19 checks incl. an anti-vacuity mutation) |
| **B2** | Mutation coupling across all 21 pairs, with restoration and source/blob identity | Control C5 in `scripts/test-request-decision-observer.ts` |
| **B3** | SQL independence on frozen triggering *and* negative boundaries for every pair, using the frozen contract projections | Control C4, same file |
| **B4** | The exact 63-case runner with complete accounting | `scripts/run-p3-1a-frozen-cases.ts`; `accountFor()` exported for direct testing; mutations in `scripts/test-p3-1a-case-runner.ts` |
| **B5** | Observations to a separate immutable run artifact; v3 byte-identical forever; verified before and after | `run-p3-1a-frozen-cases.ts` `main()`: sha256 gate before, sha256 gate after, `runs/run-<id>.json` written with the `wx` flag |
| **P** | Execution record Step 3 stale v1 governing identity; Step 2 "deferred to step 3" | `docs/superpowers/2026-09-01-p3-1a-execution-record.md` §Step 3 Identity (three-row table, v3 governing) and §Step 2 (deferral marked resolved) |

### On B1 specifically

The review's point was that reusing a predicate proves the *condition* is shared and says nothing
about the *consequence*. `BLOCK_CAPABILITY_RULES` (9) and `RETRY_CAPABILITY_RULES` (28) moved out of
the validator into one module; `classifyCapabilityRule()` reproduces the validator's original branch
order; the observer takes `OUTCOMES.query_contract_failed` **by object identity** from the shared
catalog (asserted with `===` in C2d), never a locally written `{action, reason}`.

Membership was captured from the BASE tree *before* the move and is asserted against that snapshot —
which is how I caught that my first transcription carried only 11 of BASE's 28 retry rules.

---

## 3. Test and mutation accounting

| Suite | Checks | Result |
|---|---|---|
| `test-request-decision-observer.ts` (C1–C8) | 32 | 32 passed, 0 failed |
| `test-p3-1a-case-runner.ts` (M0–M7) | 27 | 27 passed, 0 failed |
| `test-p3-1a-base-parity.ts` | 19 | 19 passed, 0 failed |
| `test-route-eligibility.js` (P2.5 guard, unchanged) | 137 | 137 passed, 0 failed |
| `test-outcome-mutations.js` | 31 mutations | 31/31 caught, every target restored |
| `test-source-capabilities`, `test-query-contract`, `test-proof-contract`, `test-outcome-coverage` | — | all passed |
| harness self-checks: discovery / contract / plan / artifact-manifest / checkout-determinism / exit-code mutations | 15 / 37 / 12 / 25 / 10 / 5-of-5 | all passed |
| `tsc --noEmit` | — | clean |

### What each mutation actually breaks

`test-p3-1a-case-runner.ts` drives the runner with **synthetic** cases only:

| Control | Deliberate break | Required to be caught as |
|---|---|---|
| M0 | *(baseline — nothing broken)* | complete, 3 agreed |
| M1 | a case left `not_run`; a short result list | `incomplete`, naming "never executed" |
| M2 | a duplicated case id | `incomplete`, duplicate named, agreed count not inflated |
| M3 | expected reason / action / applicability substituted; a stray typed pair on a non-applying case | `disagreed`, field named |
| M4 | parser disagrees / returns null / throws | recorded on the parser axis, applicability verdict **unchanged** |
| M5 | `analysis_incomplete` on a case expecting not-to-apply; observer throws | `analysis_incomplete` and `harness_error`, never `agreed` |
| M6 | rule absent from the denominator on an applying case | `disagreed`, not agreement-by-absence |
| M7 | projection applied to the shared shell | shell unmutated |

`accountFor()` is exported and tested directly because inside the runner's loop every non-duplicate
case is processed — a `not_run` guard tested only through the loop would pass without ever being
able to fail. That is the "guard never observed failing" trap from P2.5, and I would otherwise have
reproduced it.

### The BASE differential

The grid is 5 sources × 15 questions × 3 SQL inputs = **225 rows**, captured from a detached
worktree at BASE `e2d24ac` before `lib/capability-decision.ts` existed. BASE and candidate produced
**byte-identical 282,184-byte harvests**.

Adequacy is asserted rather than assumed — the suite pins that **72 rows reach a block reason, 138
reach a retry issue, and 17 distinct enforced ids appear, spanning both classes**. And it proves it
can go red: it reclassifies `unsupported-sub-city-geography` from block to retry *through the shared
authority*, requires the comparison to fail, restores, and requires it to be clean again.

---

## 4. Frozen sets are byte-identical

Verified after every step above, including after all suites ran:

| Set | sha256 | Bytes | Status |
|---|---|---|---|
| `frozen-cases-v1.json` | `2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78` | 72,452 | superseded |
| `frozen-cases-v2.json` | `7114d95c6c3a84c7da1f8e786915825436994085dfcc924477e26924203f391f` | 110,584 | superseded |
| `frozen-cases-v3.json` | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` | 112,928 | **governing** |
| `evidence/tigerweb_…_ar.html` | `265621a9368cf110a325d8c61efcbff8ea24bc7e3b142a4e6e5968ca2283c48e` | 398,745 | unchanged |

The committed git blob for v3 hashes to the same value as the working-tree file. Two independent
code paths verify v3 at runtime (`test-request-decision-observer.ts` C4, and the runner's before/
after gates) rather than trusting the path.

---

## 5. No case execution occurred

- `docs/superpowers/p3-1a/runs/` **does not exist**. The runner is the only writer, and it has not
  written.
- `run-p3-1a-frozen-cases.ts` refuses to do anything without `--run`; I executed it once *without*
  the flag to confirm the refusal, and it printed the oracle path and pinned hash and exited 0.
- `main()` has never been invoked. `buildQueryContract` has never been called against a frozen case.
- Importing the module starts nothing: `main()` is behind `require.main === module`, which is why
  the controls can import `CONTRACT_SHELL` from it safely.

---

## 6. Requirements not incorporated, and limits of what is proved

Stated in full rather than left for the reviewer to find.

**6.1 — The runner's live path has never executed.** Only the pure engine has run, driven by
injected synthetic inputs. The CLI path — sha256 gate, real `buildQueryContract` call, `wx` artifact
write, exit codes — is verified by reading, not by running. That is a genuine gap and it is the
direct consequence of "stop before executing any frozen case", so I am not treating it as a defect
to fix unilaterally. One concrete defect of exactly this class was already caught statically:
I had written `buildQueryContract({question, source})` when the production declaration at
`lib/query-contract.ts:280` is positional `(question, source, routingMeta?)`. It is fixed. **I cannot
claim it was the only one.** If you want the live path exercised without touching the oracle, a
smoke run over a 2–3 case synthetic file written to a throwaway directory would do it, and needs
its own authorization.

**6.2 — The controls evaluate production predicates on the frozen questions.** Blockers 2 and 3 ask
for mutation coupling and SQL independence "for every pair" on "frozen triggering and negative
boundaries", which cannot be done without feeding the frozen questions and the frozen expected
projections to the predicates. So C4 and C5 do. What they do **not** do: call `buildQueryContract`,
record an observation anywhere, compare expected-versus-observed applicability, or write an
artifact. No case is adjudicated.

There is a byproduct I am flagging rather than burying: **C5 establishes that all 21 positives
currently fire through both the observer and the post-SQL validator.** That is information about the
system obtained from the frozen inputs. I am not presenting it as an evidence-run result and it is
recorded nowhere as one. If you judge that this partially consumes the case set's independence, that
is a call for you and Codex, not for me — the honest position is that the frozen positives are no
longer entirely unseen, and the review's own instructions are what required them to be seen.

**6.3 — The execution-record corrections are not on the branch.**
`docs/superpowers/2026-09-01-p3-1a-execution-record.md` is untracked in the developer checkout
`C:/Users/jeffm/crime-data-assistant`, and I corrected it in place. Both corrections are in §Step 3
Identity (v1/v2 labelled superseded, v3 governing, all three hashes preserved) and §Step 2 (deferral
marked resolved, with the 5 definitions → 9 pairs → 27 cases accounting and the statement that the
projections are hand-written, never parser-produced).

**6.4 — The `enforced` ordering is compared, not reasoned about.** The BASE differential compares
`enforced` as an ordered array, so it would catch a reordering. I have not separately argued that
ordering is semantically irrelevant; the regression simply requires it not to change.

**6.5 — Not squashed.** See §1.

---

## 7. What I got wrong on the way here, since it bears on how much to trust §3

- I transcribed 11 of BASE's 28 retry rules and would have shipped a silently narrowed retry set.
  Caught only because I captured BASE membership *first* and compared mechanically. Both sets were
  then regenerated from BASE rather than hand-written.
- I wrote the parser call with an object argument against a positional signature (§6.1).
- The controls and the runner each carried a hand-written copy of the same contract shell — the
  exact drift class this candidate exists to remove. Removed in `9a19e10`.

The pattern in all three: a copy I made by hand of something that already existed. Each was caught
by comparing against the original rather than by rereading my own work.

---

## 8. Request to Codex — narrow review

> Review the corrected P3.1a candidate at commit `9a19e1045ad051afc60cb53efd8d56bd93f952b7`
> (tree `96d0888043fc2e49df6bee7e8e5a9a5475844622`) on branch
> `feat/p3-1a-request-decision-observer`, against
> `docs/superpowers/2026-09-01-p3-1a-candidate-review-round1.md`. The superseded candidate
> `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b` is preserved in history and is not for review except to
> confirm it was not mutated.
>
> **Scope: the five blockers and the precision item only.** Do not reopen the stage-placement ruling,
> the 21-pair inventory, the frozen case set contents, or Phase 2.
>
> Please determine specifically:
>
> 1. **B1** — Is `lib/capability-decision.ts` genuinely the single classification authority, or does
>    a second opinion about what a fired rule means still exist anywhere in the request path? Is the
>    BASE differential in `scripts/test-p3-1a-base-parity.ts` sufficient to support "no post-SQL
>    behaviour changed", given a 225-row grid — or does its coverage need to be argued rather than
>    asserted from the block/retry/enforced counts in §3?
> 2. **B2/B3** — Do C4 and C5 in `scripts/test-request-decision-observer.ts` actually exercise all 21
>    pairs on real frozen boundaries, or is any control passing for a reason other than the property
>    it names?
> 3. **B4/B5** — Read `scripts/run-p3-1a-frozen-cases.ts` as a frozen artifact that will run exactly
>    once. Can any case reach a verdict without being accounted for? Can `analysis_incomplete`,
>    `harness_error` or a parser disagreement reach the report as agreement? Can any run overwrite
>    the oracle or an earlier run?
> 4. **§6.2** — Rule on whether the controls' evaluation of production predicates against the frozen
>    questions compromises the independence of the 63-case evidence run. If it does, say what the
>    remedy is: a new case set, a restriction on what the evidence run may claim, or nothing.
> 5. **§6.1** — Rule on whether the runner's live path may be smoke-tested against a synthetic
>    throwaway case file before the real run, and under what bound.
>
> Also state whether the candidate should be squashed to a single commit before landing.
>
> **Do not authorize the 63-case evidence run in this review.** That is a separate decision.
