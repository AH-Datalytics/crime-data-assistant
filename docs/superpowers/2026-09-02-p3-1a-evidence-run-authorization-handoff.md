# P3.1a evidence-run authorization handoff

**Date:** 2026-09-02  
**Purpose:** give Claude the exact approved execution boundary without reconstructing the review  
**Decision:** exactly one 63-case evidence run is authorized  
**P3.2:** unauthorized

## 1. Authorized identity

| Item | Identity |
|---|---|
| Final merged commit | `e986dac6a0e5537b1a699ec01d9acb45bb3aa634` |
| Merged tree | `9d3b2f9969520dac13ef3ede00ec6a36628edd00` |
| Parent | `e2d24acd37027f436590ed8eae58bb5b30414ffb` |
| Runner SHA-256 | `aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77` |
| Governing v3 SHA-256 | `2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91` |
| Governing cases | exactly 63 |

The merge and reviewed tree identities match. PR-head and post-merge qualification passed. The
post-merge verdict was `fixture_passed` for 177 Tier F commands and `corpus_not_certified` for ten
skipped Tier C commands, with 187/187 accounting. Do not describe that qualification as corpus data
certification.

## 2. Exact authorized command

Execute from a **clean checkout at exactly the commit and tree above**. The existing developer
checkout on `feature/verified-answer-only` is dirty and is not eligible.

Use this literal single-line command:

```text
npx tsx scripts/run-p3-1a-frozen-cases.ts --run --candidate e986dac6a0e5537b1a699ec01d9acb45bb3aa634 --tree 9d3b2f9969520dac13ef3ede00ec6a36628edd00 --runner-sha aaeb1dd29694df52b878da73fe878dde6fbc94dc9a4ab278dc0b6b5878b92f77
```

This single-line form supersedes the draft's backslash-wrapped display, which is not a valid
PowerShell continuation form. No pin or argument may change.

## 3. One-shot rule

The authorization ends after the first invocation, regardless of result:

- exit 0: accounting complete and evidence conformant;
- exit 1: accounting complete, but evidence nonconformant or not established;
- exit 2: refused before execution or accounting defective.

There is no automatic retry, manual retry, second attempt, re-pin, adjusted argument, or cleanup
followed by another invocation. An exit 1 or exit 2 is a result to report and return for a new
decision.

## 4. Required pre-run checks

Immediately before invocation, verify and record:

1. `HEAD` is the exact authorized commit and its tree is the exact authorized tree;
2. `git status --porcelain` is empty;
3. the runner SHA-256 is the authorized value;
4. frozen v1, v2, and v3 match their pins;
5. v3 contains exactly 63 cases; and
6. there is no pre-existing destination artifact collision.

Do not execute if any check disagrees. Report the refusal without attempting the runner.

## 5. Required post-run verification

Before calling the artifact evidence, independently verify:

1. provenance: commit, tree, clean-worktree flag, runner/input identities, Node version, and start
   time;
2. separate `accountingVerdict` and `evidenceVerdict` values;
3. all four per-case axes: parser execution, parser agreement, predicate agreement, and case
   verdict;
4. exactly 63 cases, each parser-visited once, with no duplicate, missing, or stray ledger entry;
5. one immutable artifact at the expected destination, with nothing overwritten; and
6. unchanged frozen-set after-digests.

The result may claim exact conformance or nonconformance on the 63 predeclared deterministic
conformance cases only. The set is not an unseen holdout and does not estimate generalization or
production accuracy.

## 6. Documentation disposition

Do not open a standalone PR solely for the remaining review documentation. Round 7 review and
response are already in the merged tree. Preserve the round 8 review, the authorization review,
this handoff, and the eventual run or refusal record for one follow-up record change.

## 7. Exclusions

This authorization does not permit P3.2, enforcement, production activation, production traffic,
model calls, database writes, a second evidence run, or work beyond the exact invocation and its
verification.

## 8. Short prompt for Claude

> Read `docs/superpowers/2026-09-02-p3-1a-evidence-run-authorization-handoff.md` and follow it
> exactly. Execute the authorized 63-case run once from a clean checkout at the pinned merged
> commit using the single-line command in §2. Do not retry, re-pin, or adjust the invocation after
> any outcome. Independently verify the resulting artifact under §5, write the full run or refusal
> record to `docs/superpowers/`, and reply with only the record path, exit code, accounting verdict,
> evidence verdict, and authorization-consumed status. P3.2 remains unauthorized.
