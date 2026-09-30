# P3.1a CANDIDATE review — round 2

**Date:** 2026-09-01  
**Candidate:** `9a19e1045ad051afc60cb53efd8d56bd93f952b7`  
**Tree:** `96d0888043fc2e49df6bee7e8e5a9a5475844622`  
**Base:** `e2d24acd37027f436590ed8eae58bb5b30414ffb`  
**Frozen cases:** v3 SHA-256 `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91`  
**Scope:** the five round-1 blockers and the execution-record precision item only  
**Verdict:** **REVISE — DO NOT EXECUTE THE 63-CASE EVIDENCE RUN**

## 1. Verification performed

- The named commit and tree resolve exactly; `git diff --check` against BASE is clean.
- `scripts/test-p3-1a-case-runner.ts`: **27 passed, 0 failed**.
- `scripts/test-p3-1a-base-parity.ts`: **19 passed, 0 failed**.
- `npx tsc --noEmit`: clean.
- I did not execute `scripts/test-request-decision-observer.ts`, because C4/C5 evaluate the
  governing frozen questions and one requested ruling is whether that use consumes their
  independence. I reviewed those controls directly instead.
- I did not invoke the runner's CLI, `buildQueryContract` on a frozen question, a model, a corpus,
  a database, or production.

The corrected candidate materially improves the design. The exact production predicates are
reused, all 21 pairs appear in C4/C5, frozen v3 is not opened for writing, and synthetic mutation
tests genuinely catch skipped, duplicate, incomplete, throwing, and substituted cases. The
remaining findings are about authority and the meaning of the final evidence result, not a request
to replace the observer design.

## 2. B1 — the validator still does not consume the shared typed classification

**Blocking.** `lib/capability-decision.ts` defines `classifyCapabilityRule()`, including the typed
catalog outcome. The observer calls it. The production post-SQL validator does not: it imports
`BLOCK_CAPABILITY_RULES` and `RETRY_CAPABILITY_RULES` and repeats its own `if/else if` at
`lib/query-contract-validator.ts:708-714`.

That leaves two interpretations of a fired finding:

1. `classifyCapabilityRule()` decides `block | retry | observe_only` and supplies the typed block
   outcome for the observer;
2. the validator independently tests the two sets and derives `blockReasons`, `retryIssues`, and
   `enforced`.

The sets are shared, but the classification path is not. A later change to branch order, an
`observe_only` rule, or the typed outcome can move the observer without moving production. This is
the exact distinction round 1 made between sharing membership and sharing consequence.

**Required correction:** make the validator call `classifyCapabilityRule(finding.ruleId)` and
switch exhaustively on that result. The block branch must consume the same typed catalog outcome
the observer receives, even if the validator then separately maps the finding to its human-facing
block message. No second block/retry membership test remains in the request path.

The 225-row BASE comparison is useful and anti-vacuous, but it compares
`validateQueryContractSql()` outputs, not a route finalization outcome. Retain it, add a focused
control proving the shared typed outcome reaches the existing route-finalization classification,
and correct the report's claim that the current grid already compares route finalization.

## 3. B2/B3 — pair coverage works; restoration and parser-stop semantics do not fully close

### What passes

C4 iterates all 63 frozen cases, covers all 21 pairs and three roles, uses all 27 frozen contract
projections, exercises the throwing pre-answer context, and compares the same production rule
object under two materially different SQL values. C5 selects the 21 frozen positives and, for each
exact rule/source object, proves observer and post-SQL firing before mutation, both paths changing
under mutation, source isolation, and behavioral/reference restoration.

No control is passing merely because it used one generic non-triggering question. That round-1
defect is corrected.

### Remaining correction

C5 proves in-memory reference and behavior restoration, but it does not perform the requested
post-mutation source/blob identity check. Add a before/after digest of the exact production source
artifact(s) containing the mutated rule objects and re-verify frozen-v3 after C4/C5. This is a
small control, but it was an explicit part of B2 and should not be replaced by the assertion that an
in-memory mutation could not affect a file.

Separately, round 1 required expected-contract parser disagreement to be reported on its own axis
**and to stop the evidence run**. The runner reports it separately, but does not stop: a case can
have `parserAgreement: "disagreed"` or `"parser_error"` and simultaneously have
`disposition: "agreed"`; M4 expressly asserts that behavior. That is acceptable only if
`disposition` is renamed to make clear it is predicate/outcome agreement, and the report also has
an overall case/run verdict that cannot be agreement when the parser axis disagrees or errors.

## 4. B4/B5 — accounting is real, but the live artifact is not yet self-identifying or fail-closed

### What passes

- Duplicate IDs, short result lists, and `not_run` cases make accounting incomplete.
- `analysis_incomplete` and `harness_error` cannot become the current predicate disposition
  `agreed`.
- Observations are written separately from v3; v3 is checked before and after.
- `wx` prevents overwriting an earlier result artifact.
- The runner never opens v3 for writing.

### Blocking gaps

1. **No candidate identity gate.** The runner does not verify HEAD
   `9a19e1045ad051afc60cb53efd8d56bd93f952b7`, tree
   `96d0888043fc2e49df6bee7e8e5a9a5475844622`, a clean checkout, or equivalent exact source/blob
   identities before executing.
2. **No runner identity gate or record.** The runner's own digest/blob identity is neither pinned
   before execution nor carried in `RunReport`.
3. **The immutable artifact omits required provenance.** It records the frozen hash, but not the
   candidate commit/tree or runner identity required by round 1.
4. **A parser failure can be labelled agreement.** The parser axis is preserved, but the top-level
   case disposition is still `agreed`; the artifact has no unambiguous overall case verdict.
5. **Execution success and evidence success are conflated.** `main()` exits zero whenever accounting
   is complete, even if cases are `disagreed`, `analysis_incomplete`, or `harness_error`, or the
   parser disagreed/errored. At minimum emit two explicit verdicts—execution/accounting and
   evidence/conformance—and make their criteria and exit semantics impossible to confuse.

The correction need not make an ordinary observed disagreement a harness crash. It must make the
artifact say, unambiguously, that the run completed but the evidence did not conform, and it must
stop on the mechanical/parser divergence already named by the governing contract.

## 5. Precision item

**Accepted.** The execution record now preserves v1/v2 as superseded, names v3 as governing with
its exact identity, and closes the Step-2 projection deferral while keeping actual parser
observations pending. It is currently outside the candidate branch; preserve it in the eventual
reviewed path set rather than leaving the correction workstation-only.

## 6. Ruling on §6.2 — independence

**The controls consume unseen/holdout independence, but they do not compromise oracle
independence.**

The cases and expected outcomes were independently adjudicated and frozen before candidate
execution. That remains true. Production did not author the expected answers, and the controls do
not rewrite them.

But C4 evaluates every frozen question, and C5 selects the cases labelled `positive` and proves all
21 fire through both production paths. Those are observed system results on the governing case
set. Because the corrected candidate and controls were developed while those results were
available, the later 63-case run is not a blind or previously unseen holdout. Calling it one would
be false even though no `runs/run-*.json` exists.

**Remedy for P3.1a:** no new case set is required. Keep v3 and narrow the claim: it is an
independently adjudicated, pre-frozen **deterministic conformance set**, not an unseen estimate of
generalization or production accuracy. The formal run may still establish exact agreement on
those 63 predeclared cases after the mechanical blockers above close.

If a later certification claim needs holdout performance or an unbiased estimate beyond these
known boundaries, create a separately sequestered set that is not used to develop controls or the
candidate. Do not retrofit that larger statistical claim into P3.1a.

## 7. Ruling on §6.1 — synthetic live-path smoke test

**Yes, and it should occur before the evidence run.** It is permitted only under this bound:

1. use 2–3 newly written synthetic cases, containing none of v1/v2/v3's questions or expected
   records;
2. run the same CLI orchestration used by the real run: input hash gate, real local
   `buildQueryContract`, production observer, accounting, immutable write, and exit/verdict logic;
3. parameterize only the input path, expected input hash, output directory, and explicit run kind;
   do not fork a second smoke-only implementation;
4. label the artifact `synthetic_smoke_not_evidence` and write it to a throwaway directory outside
   `docs/superpowers/p3-1a/runs/`;
5. refuse `--smoke` if its input resolves to v1, v2, v3, or their hashes, and refuse `--run` unless
   the governing v3 identity is exact;
6. verify v1/v2/v3 before and after; make no network, model, database, corpus, or production call;
7. exercise success plus at least wrong input hash, existing output, parser disagreement/error,
   harness error, and nonconforming evidence exit/verdict paths.

This ruling authorizes the bounded synthetic smoke test design and execution after the runner is
corrected. It does **not** authorize opening or executing the 63 governing cases as evidence.

## 8. Landing shape

Land the final P3.1a candidate as one squashed commit on `dev`; do not rewrite or delete the
superseded commits before the corrected head has been reviewed and qualified. A squash merge can
preserve the review trail on the feature branch while keeping `dev` free of the superseded
candidate and intermediate corrections. Verify the merged tree is identical to the final reviewed
tree and run the required post-merge qualification.

## 9. Required response

Amend only the findings above. Preserve v1/v2/v3 and the superseded candidate. Provide:

- the validator's use of the single typed classifier and a route-finalization control;
- the post-mutation source/blob and frozen-v3 identity checks;
- candidate/tree/runner identity gates and provenance in the immutable run artifact;
- distinct parser, predicate/outcome, accounting, and overall evidence verdicts with honest exit
  semantics;
- the bounded synthetic live-path smoke test and its negative controls;
- the execution record in the final reviewed path set.

Then stop for narrow review. **The 63-case evidence run remains unauthorized. P3.2 remains
unauthorized.**
