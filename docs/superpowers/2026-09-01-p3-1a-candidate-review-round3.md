# P3.1a CANDIDATE review — round 3

**Date:** 2026-09-01  
**Branch tip reviewed:** `e40555f9f7ddbc21bda6853a12f74af15023f8fe`  
**Tip tree:** `0398033af3a85bc50d66653a459e02709c9da8b3`  
**Last code commit:** `c163a0ecc6fab8be4e5d32b9071464c6f0b87b2b`  
**Code tree at that commit:** `f0b32cebd85d11478c68ec3fd35d6bd0e8363ab2`  
**Scope:** round-2 findings only  
**Verdict:** **REVISE — DO NOT AUTHORIZE THE 63-CASE EVIDENCE RUN**

## 1. Identity and focused verification

The named tip and tree match. The three commits after `c163a0e` change only:

- `docs/superpowers/2026-09-01-p3-1a-candidate-review-round2-response.md`;
- `docs/superpowers/2026-09-01-p3-1a-execution-record.md`.

No post-`c163a0e` code change exists.

Focused verification at the clean branch worktree:

| Check | Result |
|---|---:|
| BASE parity | 23 passed, 0 failed |
| route-finalization analysis | 12 passed, 0 failed |
| case-runner accounting/verdict suite | 39 passed, 0 failed |
| synthetic live-path smoke | 45 passed, 0 failed |
| `npx tsc --noEmit` | clean |

The smoke suite used synthetic inputs in an OS temporary directory. It did not execute a frozen
case as evidence and left `docs/superpowers/p3-1a/runs/` absent.

## 2. B1 — one classification authority, but the typed carrier is not delivered

### What is corrected

`lib/query-contract-validator.ts` now calls `classifyCapabilityRule()` at the sole production
consumption site and switches exhaustively over `block | retry | observe_only`. No direct
`BLOCK_CAPABILITY_RULES.has()` or `RETRY_CAPABILITY_RULES.has()` remains in `lib/` or `app/`
outside the authority. The block branch takes `decision.outcome` from the catalog-derived
classification. This closes the second-classifier defect.

### Ruling on `capabilityOutcome`

Exposing `capabilityOutcome` does **not** create a second source of truth. It is a derived carrier:
the validator assigns it directly from `decision.outcome` inside the classifier's block branch. It
contains no independent membership list, action, or reason mapping.

But it is currently a **decorative carrier**. None of the four routes reads it. Each route still
calls `finalizeExit({ outcome: OUTCOMES.query_contract_failed, ... })` from a separate catalog
lookup. `test-p3-1a-route-finalization.ts` proves those two disconnected values currently have
object identity; it does not prove that the classifier's value reaches finalization.

That distinction matters because the accepted round-2 requirement was causal delivery, not present
equality. A future catalog or routing refactor can strand the carrier while the structural test
continues to find the literal at each route.

**Required correction:** on the capability-block path, each route must consume the validation
result's `capabilityOutcome`. Contract failures not caused by a capability rule may retain the
existing catalog fallback, for example through a single shared helper that returns
`validation.capabilityOutcome ?? OUTCOMES.query_contract_failed`. The control must prove the
carrier is read by every applicable finalization path, not merely that both ends name the same
catalog member. This is a behavior-preserving dataflow correction, not new enforcement.

## 3. Ruling on BASE keys plus one declared addition

**Accepted.** Comparing every BASE key exactly and requiring the current key-set difference to be
exactly `capabilityOutcome` preserves the regression's meaning better than regenerating the BASE
fixture would.

The suite also separately proves that the addition:

- is non-null exactly on rows enforcing a capability block;
- has catalog object identity;
- accompanies a block reason;
- is null when no capability block fired.

The four production callers consume named properties rather than serializing or spreading the
whole validation result, so the additional field does not perturb their flags-off behavior.

The claim must remain precisely stated: **every pre-existing output is identical to BASE, with one
intentional observation-only result-shape addition**. It is not literal whole-object byte equality.
Do not regenerate the BASE fixture after adding the field.

## 4. B3/B4/B5 — verdict separation is corrected; stopped-run accounting has one escape

### What passes

- Parser, predicate, case, accounting, and evidence verdicts are distinct.
- No parser disagreement or error can produce `caseVerdict: conformant`.
- A completed run cannot be conformant with an unrun, incomplete, throwing, or disagreeing case.
- Exit 0/1/2 distinguish conformant evidence, completed nonconformance/non-establishment, and
  refusal/accounting defect.
- Candidate commit/tree, clean-worktree state, runner digest, input digest, frozen-set before/after
  digests, and runtime identity are gated and recorded.
- `wx` prevents overwriting an earlier artifact; v3 is never opened for writing.

### Ruling on inverted accounting after a deliberate stop

The inversion is correct **for the predicate phase**: after parser divergence, all predicates must
remain `not_run`; otherwise the stop failed.

It is insufficient for the whole run and can mask a defect. `accountFor()` counts only
`predicateAgreement`. When one parser case diverges, `runState` becomes
`stopped_parser_divergence`; accounting then passes if every predicate is `not_run`. It does not
prove that all 63 parser cases were visited exactly once before the stop.

This is especially important because `parserAgreement: not_applicable` is both a legitimate final
state for a case without a frozen projection and the initial value before parsing. A future skipped
parser iteration can therefore remain indistinguishable from a successfully evaluated
not-applicable case, while another case's divergence activates the inverted predicate rule and the
run reports accounting complete.

**Required correction:** add an independently accountable parser-execution state, such as
`parserExecution: not_run | completed | error`, or a separately proved processed-case ledger.
Accounting after divergence must require:

1. every distinct input case was parser-processed exactly once;
2. duplicates and count mismatches remain defects;
3. at least one recorded parser disagreement/error explains the deliberate stop;
4. every predicate remains `not_run`.

Add mutations for a skipped parser case, a duplicate parser visit, a fabricated stop state with no
divergence, and a parser divergence followed by one predicate execution. Each must make accounting
incomplete or refuse.

## 5. Synthetic smoke-test ruling

**Accepted within its stated purpose.** It remained inside the round-2 bounds: three synthetic
questions absent from v1/v2/v3, content-hash refusal against frozen inputs, a temporary output
directory outside evidence, the real local parser and observer, immutable writes, explicit
non-evidence labeling, negative identity/output controls, and frozen-set verification before and
after.

The malformed-projection harness-error case is legitimate **fault injection**. It proves that an
exception arising after parser acceptance is preserved as `harness_error`, produces
`not_established`, and exits nonzero through the real CLI orchestration. It does not prove that a
valid frozen case is likely to produce that error, and the report must not make that broader claim.

## 6. Demographic-rate phrasing asymmetry

Confirmed as a separate correctness finding. It must be recorded in the next applicable defect
inventory because one phrasing reaches the intended block and a semantically equivalent phrasing
does not. Do not fix it inside P3.1a, alter frozen v3, or broaden this candidate to absorb it.

## 7. What must be true before evidence-run authorization

The fact that the positive `--run` branch has never executed is an unavoidable first-use residual:
executing it is the evidence run. The synthetic smoke provides adequate rehearsal of the shared
orchestration; a second imitation of `--run` would add confidence theater rather than remove the
boundary.

Before a separate authorization may be considered, all of the following must hold:

1. the carrier-delivery and parser-accounting corrections above are implemented and narrowly
   reviewed;
2. all focused suites, the canonical Tier F harness, and the mutation controls pass on the exact
   corrected head;
3. the final candidate is landed as one squash commit, its tree is proved identical to the final
   reviewed tree, and both the PR-head and post-merge qualification runs carry the required honest
   fixture/corpus verdicts;
4. authorization names the **final merged commit**, tree, and freshly measured runner SHA-256—not
   the current `c163a0e` or documentation tip identities;
5. execution occurs from a clean checkout at that exact merged commit, with v1/v2/v3 at their pins,
   exactly 63 governing v3 cases, and no pre-existing target artifact collision;
6. the literal one-shot command and expected exit meanings are recorded before execution; there is
   no automatic retry or changed pin after a refusal/failure;
7. the operator records the residual explicitly: v3 selection, the positive clean-worktree gate,
   and writing under the evidence directory will cross their positive branch for the first time;
8. after execution, the artifact's provenance, both verdicts, all four per-case axes, 63-case
   accounting, immutable destination, and frozen-set after-digests are independently verified
   before any result is described as evidence.

Meeting these conditions would make the run reviewable; it does not authorize it here.

## 8. Required response and landing sequence

Correct only the two remaining issues:

- deliver `capabilityOutcome` causally into route finalization and prove that dataflow;
- add complete parser-phase accounting and the four negative mutations above.

Preserve all frozen sets and the superseded candidates. Then provide a narrow response with the
new commit/tree, changed path set, focused results, and proof that no evidence run occurred.

After a clean review: squash to one commit, verify the squashed tree, qualify the exact squashed PR
head, merge, verify tree identity, run the post-merge qualification, and stop for a separate
evidence-run authorization.

**The 63-case evidence run remains unauthorized. P3.2 remains unauthorized.**
