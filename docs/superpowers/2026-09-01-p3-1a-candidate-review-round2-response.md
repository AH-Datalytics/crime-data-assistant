# P3.1a — response to candidate review round 2

**Date:** 2026-09-01
**Responds to:** `docs/superpowers/2026-09-01-p3-1a-candidate-review-round2.md`
sha256 `dcbce46af380a9566de8c0d2c6b27b247c3e4023eb42f7832824c03f7e85c351` — verified against the
value quoted in the authorization.
**Status:** all round-2 findings corrected. **The 63-case evidence run remains unexecuted and
unauthorized. P3.2 remains unauthorized.**

---

## 1. Candidate identity, and the values `--run` will demand

Superseded candidates are preserved unmodified and remain reachable.

| | |
|---|---|
| Branch | `feat/p3-1a-request-decision-observer` |
| **Corrected candidate (tip)** | `c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b` |
| **Candidate tree** | `f0b32cebd85d11478c68ec3fd35d6bd0e8363ab2` |
| **Runner sha256** | `6ab1f354b00b4103486b279fff2819bada439c265dcdbf9fcd9f345891253634` |
| Superseded | `9a19e1045ad051afc60cb53efd8d56bd93f952b7`, `c567f4aea31d0f4c5d1c0928b1a2687a8d10955b` |
| Last CODE commit | `c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b` |
| BASE | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Worktree | clean |

**On the tip moving after this document was written.** Committing this response necessarily changes
the tree, so the branch tip is one or two commits ahead of the identity table above. Those commits
are **documentation only** — verify with `git diff --numstat c163a0e HEAD`, which touches nothing
outside `docs/superpowers/`. The identity to review is the branch tip; the identity `--run` will
demand is whatever HEAD resolves to at authorization time, which is exactly why the runner takes it
as an argument instead of hard-coding it.

Those first three values are not decoration. `--run` refuses unless the operator passes
`--candidate`, `--tree` and `--runner-sha` and all three match what is actually on disk, and unless
the worktree is clean. Whoever authorizes the evidence run names the identity; the runner enforces
it. That also resolves the circularity in "the runner verifies its own commit": nothing
self-referential is committed, because the pin arrives at execution time.

**Production change vs BASE: three files, +325 / −48 lines** (`lib/capability-decision.ts` +90,
`lib/request-decision-observer.ts` +174, `lib/query-contract-validator.ts` +61/−48). Everything
else is test, fixture, frozen artifact, manifest or document.

---

## 2. Finding → correction map

| Finding | Correction | Where |
|---|---|---|
| §2 B1 — validator does not consume the shared classification | `classifyCapabilityRule()` called at the single consumption site, switched on **exhaustively** with a `never` guard; both private membership tests gone | `lib/query-contract-validator.ts` |
| §2 B1 — block branch must consume the typed catalog outcome | The block branch assigns `decision.outcome`; it is carried on the result as `capabilityOutcome` | same file, `QueryContractSqlValidation` |
| §2 B1 — add a route-finalization control | New suite following the chain for all 9 block rules at runtime, plus TypeScript-AST analysis of what all four routes pass to `finalizeExit` | `scripts/test-p3-1a-route-finalization.ts` |
| §2 B1 — correct the claim that the grid compares route finalization | Corrected in §7 below and in the suite's own header | this document |
| §3 B2 — post-mutation source/blob identity | C5g digests four production sources before/after; C5h/C5i re-verify all three frozen sets after C4 and C5 | `scripts/test-request-decision-observer.ts` |
| §3 B3 — parser divergence must stop the run | Two-phase execution; a divergence stops before any predicate runs | `scripts/run-p3-1a-frozen-cases.ts` |
| §3 B3 — rename `disposition`; add an overall verdict | `predicateAgreement`, plus `caseVerdict` and two run verdicts | same |
| §4 gaps 1–3 — candidate/runner identity gates and provenance | `--candidate`/`--tree`/clean-worktree/`--runner-sha` gates; all recorded in `provenance` | same |
| §4 gap 4 — a parser failure could be labelled agreement | `deriveCaseVerdict()` makes a parser divergence nonconformant regardless of the predicate axis | same |
| §4 gap 5 — execution success conflated with evidence success | `accountingVerdict` and `evidenceVerdict` are separate; exit 0/1/2 have distinct meanings | same |
| §5 — the record was workstation-only | The execution record and the whole P3.1a document set are now on the branch | `docs/superpowers/` |
| §7 — bounded synthetic smoke test | Implemented **and executed**: 45 assertions | `scripts/test-p3-1a-smoke-live-path.ts` |
| §6 — narrow the claim | Recorded in the execution record and §5 below | execution record |

### The four questions, now answered separately

| Axis | Values |
|---|---|
| `parserAgreement` | `agreed` / `disagreed` / `not_applicable` / `parser_error` |
| `predicateAgreement` | `agreed` / `disagreed` / `analysis_incomplete` / `harness_error` / `not_run` |
| `caseVerdict` | `conformant` / `nonconformant` / `not_established` |
| run verdicts | `accountingVerdict` (is the RUN trustworthy) and `evidenceVerdict` (did the SYSTEM conform) |

`deriveCaseVerdict()` is exhaustively tested over all 5 × 4 = 20 combinations. A parser divergence
is nonconformant on every one of them.

**Exit codes:** `0` accounted **and** conformant · `1` the run was trustworthy but the evidence was
not conformant or not established · `2` refused before running, or the accounting itself was
defective.

One consequence worth naming because it is not obvious: the accounting rule **inverts** after a
deliberate stop. Normally `not_run > 0` is a defect; after a parser divergence, anything *other*
than every case being `not_run` is the defect, because a half-processed set would mean the stop did
not stop anything.

---

## 3. Test and mutation accounting

| Suite | Checks | Result |
|---|---|---|
| `test-request-decision-observer.ts` (C1–C8) | 35 | 35 passed |
| `test-p3-1a-case-runner.ts` (M0–M8) | 39 | 39 passed |
| `test-p3-1a-base-parity.ts` | 23 | 23 passed |
| `test-p3-1a-route-finalization.ts` (R1–R3) | 12 | 12 passed |
| `test-p3-1a-smoke-live-path.ts` (S0–S5) | 45 | 45 passed |
| `test-route-eligibility.js` (P2.5, unchanged) | 137 | 137 passed |
| `test-outcome-mutations.js` | 31 | 31/31 caught, all restored |
| `test-source-capabilities`, `test-query-contract`, `test-proof-contract`, `test-outcome-coverage`, `test-outcome-inventory`, `test-route-egress-contract`, `test-proof-finalize` | — | all passed |
| harness discovery / contract / plan / artifact-manifest / checkout-determinism / exit-code mutations | 15 / 37 / 12 / 25 / 10 / 5-of-5 | all passed |
| `tsc --noEmit` | — | clean |

All five P3.1a suites are registered in the tier manifest as Tier F and in `harness:test`. The
**evidence runner is deliberately not registered** — a harness run must never be able to start it,
and `test-artifact-manifest` confirms it is absent.

### The smoke test, in detail (round 2 §7)

45 assertions across 12 real CLI invocations, all inside an OS temp directory:

- **S0** — the three synthetic questions appear in none of v1/v2/v3, and the input hashes to none
  of them.
- **S1** — the success path end to end: exit 0, exactly one artifact, `runKind:
  synthetic_smoke_not_evidence`, filename prefixed `smoke_not_evidence-`, run completed, accounting
  complete, evidence conformant, the **real** `buildQueryContract` ran and agreed on the one
  projected case, provenance carries runner/input/candidate/node, and all three frozen sets were
  verified before *and* after.
- **S2** — the immutable write. Every filename the next run could choose is pre-created for the
  current second and the next seven, so the collision is deterministic rather than a race the test
  would sometimes lose. Exit 2, nothing written, no pre-existing file modified.
- **S3** — nine refusals: wrong input hash · wrong runner pin · missing runner pin · a frozen set by
  path · **frozen content under an innocent filename** (refusal is by content, not just name) ·
  writing into the evidence directory · a `--run` candidate mismatch. None wrote anything.
- **S4** — all four failure verdicts through the live path: a nonconforming expectation (exit 1,
  completed, nonconformant) · a parser disagreement (exit 1, `stopped_parser_divergence`, no
  predicate evaluated, zero conformant) · a parser error (exit 1, stopped) · a harness error (exit
  1, completed, `not_established`).
- **S5** — all three frozen sets byte-identical afterwards, and `runs/` still does not exist.

The harness-error case needed a specific shape and I want that on the record rather than buried: it
uses a deliberately malformed projection (`metric.topic.length`) that the parser *agrees* with, so
phase 1 passes and phase 2 throws. It is the only shape that can reach `harness_error` through the
CLI, because any projection the parser disagrees with stops the run first. That is a property of
the design, not a workaround.

---

## 4. Frozen sets — byte-identical

Verified before and after every suite, including the smoke run:

| Set | sha256 | Bytes | Status |
|---|---|---|---|
| `frozen-cases-v1.json` | `2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78` | 72,452 | superseded |
| `frozen-cases-v2.json` | `7114d95c6c3a84c7da1f8e786915825436994085dfcc924477e26924203f391f` | 110,584 | superseded |
| `frozen-cases-v3.json` | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` | 112,928 | **governing** |

The governing documents now on the branch carry their reviewed hashes: contract `2896d1c5…`,
stage-placement ruling `bb98575d…`, step-2 coverage ruling `127f1dce…`, round-1 review
`b708feb2…`, round-2 review `dcbce46a…`.

---

## 5. The narrowed claim (§6), accepted and recorded

The 63 cases are an **independently adjudicated, pre-frozen deterministic conformance set** — not an
unseen holdout and not an unbiased estimate of generalization or production accuracy. The controls
evaluate the frozen questions, so the set has been seen; the expected outcomes were nevertheless
authored and frozen before any candidate execution and nothing rewrites them, so oracle
independence is intact. No replacement set is created. This is recorded in the execution record so
a later reader cannot pick up the stronger claim by accident.

---

## 6. Requirements not incorporated, and remaining limits

**6.1 — The evidence run's own exact path has still never executed.** The smoke test exercises the
same orchestration with the same code, but with `--smoke`, a synthetic input and a temp output
directory. Three things therefore remain verified by construction rather than by execution: the
`--run` branch reading v3, writing into `docs/superpowers/p3-1a/runs/`, and passing the
clean-worktree gate positively. The refusal side of that gate *was* executed (S3j). This gap is a
direct consequence of the standing instruction and I am not closing it unilaterally.

**6.2 — `capabilityOutcome` is exposed but the routes do not yet consume it.** The four routes still
pass `OUTCOMES.query_contract_failed` literally; the new field proves they name the same object,
and R2d asserts none of them uses a hand-written literal instead. Rewiring the routes to read the
field would be a behaviour change beyond "prove the outcome reaches finalization", so I did not do
it. If you want that rewiring, it needs its own authorization.

**6.3 — A production observation, reported and not fixed.** `"rate per capita for <group>
residents"` sets `metric.unsupportedReason = demographic_rate_denominator_unavailable` and the
demographic-rate block fires; `"rate per 100,000 <group> residents"` does **not** set it and the
block does not fire. I found this while probing for trigger questions. It looks like a real gap in
`buildQueryContract` — a demographic-rate request that escapes a block meant to catch it — but it
is outside P3.1a and I have changed nothing. Worth its own item.

**6.4 — Not squashed yet.** §8 says to land as one squashed commit *after* correction, review and
qualification, and not to rewrite the superseded commits before the corrected head is reviewed. So
the branch still carries five commits. On your word after this review I will produce the single
squashed commit, verify the squashed tree is identical to the reviewed tree, and run both
qualification runs.

**6.5 — The smoke suite adds roughly two minutes to the canonical harness**, because it spawns the
runner twelve times. I judged continuous verification of the live path worth that; say so if you
would rather it were excluded from `harness:test` and run only on demand.

---

## 7. Corrections to my own round-1 report

- I wrote that the 225-row BASE grid compared route finalization outcomes. **It does not** — it
  compares `validateQueryContractSql()` outputs. `test-p3-1a-route-finalization.ts` is what compares
  finalization, and it did not exist when I made that claim.
- I described the shared-set extraction as giving the observer and production one classification.
  It gave them one **membership list**; the consequence was still decided in two places until this
  round. The round-2 finding was correct and my §2 heading in the round-1 response overstated what
  had been achieved.

---

## 8. Request to Codex — narrow review, round 3

> Review the corrected P3.1a candidate at commit `c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b`
> (tree `f0b32cebd85d11478c68ec3fd35d6bd0e8363ab2`) on branch
> `feat/p3-1a-request-decision-observer`, against
> `docs/superpowers/2026-09-01-p3-1a-candidate-review-round2.md`. Superseded candidates `9a19e10…`
> and `c567f4a…` are preserved and are not for review except to confirm they were not mutated.
>
> **Scope: the round-2 findings only.** Do not reopen the stage-placement ruling, the 21-pair
> inventory, the frozen case contents, the independence ruling, or Phase 2.
>
> Please determine:
>
> 1. **B1** — Does `lib/query-contract-validator.ts` now genuinely consume the shared classification,
>    with no second interpretation of a fired finding anywhere in the request path? Is
>    `scripts/test-p3-1a-route-finalization.ts` sufficient to support "the shared typed outcome
>    reaches route finalization", given that the last hop is proved structurally rather than by
>    executing a route? Is adding `capabilityOutcome` to the result the right way to make that
>    linkage testable, or does exposing it create a second source of truth of its own?
> 2. **Baseline handling** — I did **not** regenerate the BASE baseline for the added field. Instead
>    every BASE key is compared exactly and the key-set difference must equal one declared addition.
>    Rule on whether that preserves the regression's meaning or quietly weakens it.
> 3. **B3/B4/B5** — Read `scripts/run-p3-1a-frozen-cases.ts` as an artifact that will run once. Can
>    a case reach `conformant` while its parser axis diverged? Can a run report conformance without
>    accounting for all 63? Can any run overwrite the oracle or an earlier artifact? Are the exit
>    semantics unambiguous? Is the inverted accounting rule after a deliberate stop correct, or does
>    it create a way for a stop to mask a defect?
> 4. **§7 smoke test** — Read `scripts/test-p3-1a-smoke-live-path.ts` and confirm it stayed inside
>    every bound. In particular: is the harness-error scenario (§3 above) legitimate, or is it
>    testing an artificial shape that tells us nothing about the real path?
> 5. **§6.1** — State what, if anything, must still be true before the 63-case evidence run is
>    authorized, given that the `--run` branch itself has never executed.
> 6. **§6.3** — Confirm the demographic-rate phrasing asymmetry should be raised as its own item and
>    not folded into P3.1a.
>
> If you are satisfied, say so and name the landing sequence you want: squash, review of the
> squashed head, both qualification runs, then a separate authorization for the evidence run.
>
> **Do not authorize the 63-case evidence run in this review.**
