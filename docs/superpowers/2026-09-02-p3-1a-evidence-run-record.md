# P3.1a — evidence-run record

**Date:** 2026-09-02
**Authorization:** `docs/superpowers/2026-09-02-p3-1a-evidence-run-authorization-review.md`
sha256 `d617a2198bd1af22860c7fb9cd5ee91ae3186fc63adf902fe0f39dc4a972ddc3` — APPROVED WITH
COMMAND-FORM CORRECTION, exactly one run, no retry.
**Outcome:** the run completed and **the evidence is NONCONFORMANT**. Exit 1. **No retry was
performed and none will be without a new decision.**

---

## 1. Headline

**58 of 63 conformant. 5 nonconformant.** All five are the same rule definition,
`unsupported-sub-city-geography`, across all five of its sources — one underlying defect counted
once per applicability pair.

The defect is a **false refusal**: the sub-city geography predicate fires on a question about
**Ward, Arkansas — a real incorporated city** — treating it as a request for geography below city
level.

This is exactly the case the frozen set was built to probe, and its expectation was adjudicated and
frozen on 2026-09-01, before any candidate execution, against independent Census evidence.

## 2. Execution

Single authorized invocation, from a clean checkout at the merged commit:

```
npx tsx scripts/run-p3-1a-frozen-cases.ts --run --candidate e986dac6a0e5537b1a699ec01d9acb45bb3aa634 --tree 9d3b2f9969520dac13ef3ede00ec6a36628edd00 --runner-sha aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77
```

**Exit code 1** — "accounting complete, but evidence nonconformant or not established; report it
without retry."

### A precondition failure caught BEFORE the invocation

The first checkout prepared for this run was made with `core.autocrlf=true`. Every byte-hashed pin
mismatched — runner `fa8f6b47…` instead of `aaeb1dd2…`, v3 `aebbcb3a…` instead of `2535cbd9…`,
115,323 bytes instead of 112,928 — because the checkout inserted 2,395 CR bytes into files whose
committed form is pure LF.

Running then would have spent the single authorization on a refusal. The checkout was replaced with
one cloned at `core.autocrlf=false`, and every pin re-verified before the command was issued. This
is the recorded CRLF provenance trap doing what it was recorded for.

## 3. Post-run verification *(authorization §8, all six items)*

| # | Requirement | Result |
|---|---|---|
| 1 | provenance | candidate `e986dac6…`, tree `9d3b2f99…`, `worktreeClean: true`, runner `aaeb1dd2…`, input `frozen-cases-v3.json` `2535cbd9…`, Node v24.14.0, started 13:07:44Z, `runKind: evidence` |
| 2 | both verdicts, separate | `accountingVerdict: complete` (detail null) · `evidenceVerdict: nonconformant` ("5 case(s) did not conform") · `runState: completed` |
| 3 | all four per-case axes | present on all 63 cases |
| 4 | exact 63-case accounting | caseCount 63, results 63, unique ids 63; predicate sum 63; verdict sum 63; **parserVisits: 63 entries, every one exactly 1**; parserExecution `{not_run:0, completed:63, error:0}` |
| 5 | immutable destination | exactly one artifact written, `runs/run-20260902_130744.json`, 41,419 bytes; no tracked file modified |
| 6 | frozen-set after-digests | v1 `2a2739cc…`, v2 `7114d95c…`, v3 `2535cbd9…` — unchanged, and the artifact's own before/after digests are equal |

Counts: `predicateCounts {not_run:0, agreed:58, disagreed:5, analysis_incomplete:0, harness_error:0}` ·
`verdictCounts {conformant:58, nonconformant:5, not_established:0}` ·
`parserCounts {not_applicable:36, agreed:27}`.

**No parser divergence, no analysis-incomplete case, no harness error.** The five disagreements are
findings about the system, not defects in the run.

## 4. The finding

| | |
|---|---|
| Cases | `P31A-002`, `-005`, `-008`, `-011`, `-014` |
| Definition | `unsupported-sub-city-geography` |
| Sources | current, historical, nibrs, shr, hate_crime — all five |
| Role | `false_acceptance` (the negative probe) |
| Question | *How many murders were reported in Ward, AR in 2022?* |
| Expected | does not apply — no action, no reason |
| Observed | **fired**, carrying `decline_capability / query_contract_failed` |

**Adjudication basis, frozen 2026-09-01:** Ward, Arkansas is a real incorporated city; the question
is city-level and answerable, and the rule's stated scope excludes only geography *below* city
level.

**Probe basis, frozen 2026-09-01:** "Designed against the pattern edge: the sub-city detector
matches the standalone token 'ward'. A city legitimately named Ward should not be refused as a
sub-city request."

**Independent evidence, frozen in v3:** the TIGERweb BAS26/ACS25 record for Ward, AR — GEOID
`0573130`, NAME "Ward city", LSADC 25, FUNCSTAT A, MTFCC G4110 — preserved at
`docs/superpowers/p3-1a/evidence/tigerweb_bas26_incplace_2025_acs25_ar.html`
(`265621a9…`), with the exact row hashed separately.

By role: positives **21/21 conformant**, false-refusal probes **21/21 conformant**,
false-acceptance probes **16/21** — every failure is in the over-firing direction.

## 5. What this result may and may not be called

It may be called: **exact agreement on 58 of 63 predeclared deterministic conformance cases, with 5
disagreements concentrated in one rule definition.**

It may **not** be called an unseen holdout, an estimate of generalization, or a measure of
production accuracy. The controls evaluated these questions during development; the expectations
were nevertheless authored and frozen before any candidate execution and nothing rewrote them.

**Two things this run did NOT establish**, and no work was done toward either:

1. **End-to-end production impact.** The observer measures the predicate. Production reaches that
   predicate only after SQL exists. Whether a real request for Ward, AR is declined end to end was
   not tested here, and testing it is outside this authorization.
2. **Which side is wrong.** The observation disagrees with an independently adjudicated
   expectation. The adjudication is documented and evidence-backed, which is why this is recorded
   as a probable production defect — but confirming that, and any fix, is separate work.

## 6. Artifacts

| | |
|---|---|
| Run artifact | `run-20260902_130744.json`, sha256 `a97860ee73cc6b775a1828f7a540e6dfb8402956094a8c5597f8866629a6535e`, 41,419 bytes |
| Preserved at | `C:/Users/jeffm/cda-evidence/p3-1a-evidence-20260902/` |
| Written by the run at | `C:/Users/jeffm/cda-evidence/p3-1a-evidence-run-20260902-lf/docs/superpowers/p3-1a/runs/` |
| On `dev` | **not yet** — `docs/superpowers/p3-1a/runs/` remains absent on `dev` |

## 7. Correction note — the first attempt to land this record failed CI

Recorded for an honest audit trail rather than quietly amended away.

The first qualification of the records-only PR (#12) **failed**: GitHub Actions run `33636266206`,
`tally: 176 passed, 1 failed, 10 skipped, 0 blocked = 187`, verdict `fixture_failed` /
`corpus_not_certified`. One command failed —
`scripts/test-p3-1a-smoke-live-path.ts`, assertion **S5c**.

S5c asserted `fs.existsSync(EVIDENCE_RUNS_DIR) === false`. That encoded a premise — *no evidence
run has ever happened* — which was true when the assertion was written and which committing the
first legitimate evidence artifact **correctly falsifies**. The test was stale; the record change
was not wrong.

It was corrected under
`docs/superpowers/2026-09-02-p3-1a-record-landing-smoke-invariant-amendment-handoff.md`, which
amended the records-only path restriction to permit exactly that one file. S5c now compares a
deterministic, content-addressed recursive snapshot of the evidence directory before and after the
whole suite — relative paths, entry types, sizes, sha256, and link targets recorded without
traversal — so it holds in every state and, unlike a filename listing, detects byte modification of
an artifact that is already present. S6 exercises the snapshot helper against a disposable fixture
to prove it detects addition, deletion, same-name same-size modification, and absent versus
present-but-empty. The direct gate S3i, proving `--smoke` refuses an output path inside the evidence
directory, is unchanged.

The failed run remains visible and was not re-run unchanged, bypassed, or worked around by weakening
harness accounting or CI configuration.

## 8. Open, for decision

1. **Land this record**, the round-8 review and the authorization together in one follow-up change,
   per the authorization's documentation disposition. Costs two CI runs. Not done.
2. **The Ward, AR defect** needs an owner: confirm production impact, then decide whether the fix
   belongs in P3.1b, P3.2, or a standalone correctness item. **Not fixed here** — fixing it is
   outside this authorization, and the frozen set must not be altered to match the system.
3. **The demographic-rate phrasing asymmetry** (rounds 3–7) still has no inventory home: *"rate per
   capita for <group> residents"* sets `metric.unsupportedReason` and blocks, while *"rate per
   100,000 <group> residents"* does not.
